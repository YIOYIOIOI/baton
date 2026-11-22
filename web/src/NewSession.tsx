import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserLock, onBrowserLock } from '../../app/src/store/browserSession';
import { watchCreation, type CreationReceipt } from '../../app/src/api/creationStatus';
import { ApiError, api, type Agent } from './api';
import { DirPicker } from './DirPicker';
import { translate, useI18n, type Locale } from './i18n';
import { dirName, join } from './paths';
import { navigate } from './router';
import { Ball } from './Ball';
import { InputBox } from './InputBox';
import { SessionConfig } from './SessionConfig';
import { DraftAttachments } from './Attachments';
import { pastedName } from './useFileDrop';
import { attachmentSuffix, isImageName } from './attach';
import { NEW_SESSION_DRAFT, useDraft } from './drafts';
import './new.css';

/**
 * 新建会话 = **一个还没开始的会话，不是一张表单。**
 *
 * 上一版是四格表单：Agent 分段控件 / 工作目录下拉 / 模型下拉 / 一个标着
 * 「第一条消息」的 textarea / 「开始」按钮。而 Claude、ChatGPT、以及本仓库的
 * 手机端（`app/src/app/new.tsx` 抬头原话：「新会话 = 一个空的会话窗口，不是表单…
 * 开窗口这一步不该问你任何问题」）都是同一个做法：
 *
 *   一句问候 + 一个输入框，执行方式收进输入框上方的药丸，打字发出去才真正建会话。
 *
 * ## 输入框居中，不贴底
 *
 * 空态下输入框**垂直居中**，有内容之后才沉到底部——Claude 与 ChatGPT 都是如此，
 * huggingface/chat-ui 也专门提交过这个改动。`/new` 永远是空态（一发送就跳去会话页），
 * 所以这里恒居中。
 *
 * 居中布局确实有「草稿一长就把发送键顶出视口」这个坑，但**封它的是 textarea
 * 自己的 `max-height: 200px`**（inputbox.css），整块最高 ~215px，顶不动谁。
 * 我一度在外面又加了一层 `overflow-y: auto` 去封，结果把药丸弹出的面板整个剪掉了
 * ——绝对定位的子元素逃不出带 overflow 的祖先。类型和构建都不报，实测才看出来。
 *
 * 两颗药丸开出来的都是居中浮窗（Modal.tsx），不是贴着药丸的下拉——2026-11-04
 * 之前是下拉，方向和高度都被「输入框居中」牵着走，只能封在半屏。
 *
 * ## 两颗药丸，不是四颗
 *
 * agent / 模型 / 思考强度 / 权限全折进「配置」；**工作目录单独留着**——
 * 手机端那条注释说得对：它是**内容**不是执行方式，选错等于在别的项目里开会话，
 * 和调模型不是一类事。
 *
 * ## 服务端仍然要求第一句话
 *
 * `createSession` 里 `if (!text.trim())` 直接 400 `empty_message`。所以「不填消息
 * 就建一个空会话」这件事客户端做不到——这一版改掉的是**把它做成表单第四格**，
 * 不是取消它。
 *
 * ## 身份分支：一处都没有
 *
 * `cwds` 给的是这个调用者能用的快捷列表，`/api/dirs` 起点给的是他能看的入口，
 * `parent` 为 null 就是他不能再往上。照接口写，owner 和访客都对（契约文档 §0）。
 */

function greeting(locale: Locale, d = new Date()): string {
  const h = d.getHours();
  if (h < 6) return translate(locale, 'new.greetNight');
  if (h < 12) return translate(locale, 'new.greetMorning');
  if (h < 18) return translate(locale, 'new.greetAfternoon');
  return translate(locale, 'new.greetEvening');
}

/**
 * 自动新建的目录名。
 *
 * 日期 + 时分：可排序、无注入面（如 `2026-09-15-0930`）。
 * **不从第一句消息取名**——那是任意文本，当文件名要先过一遍消毒
 * （服务端的 `safeName` 是给上传用的，不在这条路上），而且一句话未必短。
 */
function folderName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 地址里带的目录和 agent：侧栏组头上那颗「在这里开新会话」跳过来时给的（2026-11-11），
 * `/new?cwd=<目录>&agent=codex`。没带就是空，照原来的默认走。
 */
function fromUrl(): { cwd: string; agent: Agent | null } {
  const q = new URLSearchParams(window.location.search);
  const a = q.get('agent');
  return {
    cwd: q.get('cwd') ?? '',
    agent: a === 'claude' || a === 'codex' || a === 'antigravity' ? a : null,
  };
}

export function NewSession() {
  const { locale, t } = useI18n();
  const [agent, setAgent] = useState<Agent>(() => fromUrl().agent ?? 'claude');
  const [cwd, setCwd] = useState(() => fromUrl().cwd);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  // 草稿存在这一页之外，离开再回来还在（见 drafts.ts）。建成之后清掉
  const [draft, setDraft] = useDraft(NEW_SESSION_DRAFT);
  /**
   * 还没传上去的附件（见 create 抬头）。File 留在本地，点发送才上传。
   *
   * `uploaded` 是**重试不重复上传**用的：上传成功但建会话失败时（凭据缺失、
   * 模型名非法都是活的失败路径），人在原地再点一次发送，已经传上去的那几个
   * 直接跳过。不记的话，服务端同名不覆盖（uniquePath），每retry一次就多一代
   * a-2.png / a-3.png，而消息只引用最后一代。手机端一直是这么做的
   * （app/src/store/attach.ts 的 Staged.uploaded）。
   */
  const [staged, setStaged] = useState<{
    file: File;
    preview: string | null;
    uploaded: { relative: string; bytes: number } | null;
  }[]>([]);
  const [cwds, setCwds] = useState<string[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<(CreationReceipt & { error?: string }) | null>(null);
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!receipt || receipt.error !== undefined || getBrowserLock()) return;
    const stop = watchCreation(receipt, api.creationStatus, (key) => {
      if (active.current && !getBrowserLock()) {
        window.dispatchEvent(new Event('baton:sessions'));
        navigate('/session/' + encodeURIComponent(key));
      }
    }, (error) => { if (active.current && !getBrowserLock()) setReceipt({ ...receipt, error }); });
    const off = onBrowserLock(() => { if (getBrowserLock()) { stop(); setReceipt(null); } });
    return () => { stop(); off(); };
  }, [receipt]);
  const [err, setErr] = useState<ApiError | null>(null);
  const [picking, setPicking] = useState(false);
  /**
   * 选中的目录是「这个调用者能看到的顶」。顶上不直接开工——访客的顶是他的工作区根，
   * owner 的顶是盘符根，两边都不该拿来当 cwd（谁也不想让 agent 跑在 `C:\` 上）。
   * 为真时发送前先在它下面建一个 `plan` 那个名字的文件夹。
   */
  const [atTop, setAtTop] = useState(false);
  const [plan] = useState(folderName);
  /**
   * 认出来的那个「顶」。记着它是为了**能反悔**：选了具体目录之后，还得有一条路
   * 回到「用自动新建的那个」，否则那个默认一旦被替掉就再也回不去了。
   */
  const [topDir, setTopDir] = useState<string | null>(null);

  /**
   * 判「是不是顶」只看服务端给的 `parent`：**站在某个目录里而 `parent === null`,
   * 就是到顶了**（契约文档把这条写在 /api/dirs 的字段说明里）。
   *
   * 这样就不需要「我是不是访客」的分支——契约文档 §0 明确不许那么写，而且
   * 那个分支还会漏掉 owner 选了 `C:\` 的情况。
   */
  const checkTop = useCallback((dir: string) => {
    if (!dir) return;
    api
      .dirs(dir)
      .then((p) => {
        const top = p.parent === null;
        setAtTop(top);
        // 记住它，好让「反悔」有得可回
        if (top) setTopDir(dir);
      })
      .catch(() => setAtTop(false));
  }, []);

  useEffect(() => {
    // allowSend 是调用者自己的有效值，决定「新建文件夹」能不能按
    api.health().then((h) => setCanWrite(h.allowSend === true)).catch(() => setCanWrite(false));
    api
      .sessions()
      .then((d) => {
        setCwds(d.cwds);
        // 从组头「在这里开新会话」进来的，用它带的目录；否则用快捷列表的第一个
        const first = fromUrl().cwd || (d.cwds[0] ?? '');
        setCwd((v) => v || first);
        // 一进来就判，好让药丸先把「会新建一个」说出来，而不是发送时才蹦出来
        if (first) checkTop(first);
      })
      .catch((e: ApiError) => {
        if (e.status === 401) window.location.href = '/pair';
      });
  }, [checkTop]);

  /*
    已经停在新建页上、又点了另一个组的「在这里开新会话」：页面不重挂载（路径都是 /new），
    这里跟着地址换目录和 agent
  */
  useEffect(() => {
    const sync = () => {
      const u = fromUrl();
      if (u.cwd) {
        setCwd(u.cwd);
        checkTop(u.cwd);
      }
      if (u.agent) {
        // 从「在这里开新会话」进来就是重新开始：模型和强度回到默认（两边的可选集也不一样）
        setAgent(u.agent);
        setModel(null);
        setEffort(null);
      }
    };
    window.addEventListener('baton:navigate', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('baton:navigate', sync);
      window.removeEventListener('popstate', sync);
    };
  }, [checkTop]);

  /** 实际要用的工作目录。在顶上时是「顶 + 新文件夹」。 */
  const target = atTop ? join(cwd, plan) : cwd;

  /**
   * 还没传上去的附件。**会话还不存在，所以字节只能先留在本地。**
   *
   * 点发送时才走 `/api/uploads`（按 cwd 传，不按会话——那一刻没有 key），
   * 拿到路径再建会话。中途离开这一页就随组件消失，什么都不用清：
   * 那时候一个字节都还没上传。手机端是同一个模型（app/src/app/new.tsx）。
   */
  async function create() {
    const text = draft.trim();
    // 光有附件也能发——第一条消息可以只是几个文件
    if ((!text && !staged.length) || !cwd || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // 在顶上就先把那个文件夹建出来。mkdir 是递归的，且「已存在」回 200
      // created:false（契约说了这不是错误），所以重复点也安全。
      if (atTop) await api.mkdir(target);

      /*
        先把附件传到那个工作目录，再带着路径建会话。
        顺序不能反：createSession 是「建会话 + 跑第一轮」一次做完的，而 agent
        只认磁盘路径——路径必须出现在第一条消息里。那一刻还没有 session key，
        所以走按 cwd 的那条端点。
      */
      const next = [...staged];
      try {
        for (let i = 0; i < next.length; i += 1) {
          if (next[i].uploaded) continue; // 上一次已经传成功了
          const up = await api.uploadToCwd(target, pastedName(next[i].file), next[i].file);
          next[i] = { ...next[i], uploaded: { relative: up.relative, bytes: up.bytes } };
        }
      } finally {
        // **成功的要先记下来再决定抛不抛**，否则重试会重复上传
        setStaged(next);
      }
      const done = next.flatMap((it) => (it.uploaded ? [it.uploaded] : []));
      // 正文为空时，消息就是那段附件清单本身（它非空，服务端的 empty_message 才过）
      const suffix = attachmentSuffix(done);
      const message = text ? text + suffix : suffix.trimStart();

      const r = await api.createSession({ agent, cwd: target, message, model, effort });
      if (!active.current || getBrowserLock()) return;
      setDraft('');
      if (r.status === 'unconfirmed' && r.turnId) {
        for (const it of next) if (it.preview?.startsWith('blob:')) URL.revokeObjectURL(it.preview);
        setStaged([]);
        setReceipt({ turnId: r.turnId, statusUrl: r.statusUrl });
        return;
      }

      // 旧版只提供 provider 的 sessionId，向会话列表反查它对应的文件。
      const key = r.key ?? (r.sessionId
        ? (await api.sessions()).chains.flatMap((c) => c.members).find((m) => m.providerId === r.sessionId)?.key : null);
      if (!active.current || getBrowserLock()) return;

      /*
       * 让外壳重新拉一次列表。
       *
       * 不喊这一嗓子的话，新会话要等侧栏那 30 秒的轮询才进列表——而**会话页的
       * 标题和目录是从列表里取的**（`useMember`），于是刚建完那一下页头是空的。
       * 这条路正是新用户的必经之路，不该是第一眼就看到一个空标题。
       */
      // 走之前把预览放掉：SPA 不刷新页面，不放就一直占着那几份字节
      for (const it of next) {
        if (it.preview?.startsWith('blob:')) URL.revokeObjectURL(it.preview);
      }
      window.dispatchEvent(new Event('baton:sessions'));
      navigate(key ? `/session/${encodeURIComponent(key)}` : '/');
    } catch (e) {
      setErr(e as ApiError);
      setBusy(false);
    }
  }

  /** `cwd_not_found` 正好是提示「要不要建一个」的时机（契约文档 §4）。 */
  async function createDirThenSession() {
    setBusy(true);
    setErr(null);
    try {
      await api.mkdir(target);
      setBusy(false);
      await create();
    } catch (e) {
      setErr(e as ApiError);
      setBusy(false);
    }
  }

  if (receipt) return (
    <div className="compose"><div className="new-stack" role="status">
      <p>{receipt.error !== undefined
        ? receipt.error || (locale === 'en' ? 'This receipt is unavailable.' : '当前无法查看这张回执。')
        : locale === 'en' ? 'Checking whether Antigravity Desktop created your session…' : '正在核对 Antigravity 桌面端是否已建好会话…'}</p>
      <p className="dim">{locale === 'en' ? 'Request' : '查询编号'} <code>{receipt.turnId}</code></p>
      <button className="ghost" type="button" onClick={() => navigate('/')}>{locale === 'en' ? 'Back to sessions' : '返回会话列表'}</button>
    </div></div>
  );
  return (
    <div className="compose">
      {/* 问候与输入框是**一组**，一起垂直居中。分开居中的话草稿变长时
          问候语会被往上顶，看着像页面在抖 */}
      <div className="new-stack">
        <div className="new-hero">
          <Ball size={26} />
          <h1 className="new-greet">{greeting(locale)}</h1>
        </div>

        {err && (
          <p className="compose-err" role="alert">
            <span>{err.message}</span>
            <span className="dim">{err.fix}</span>
            {/* 目录不存在是唯一一个「这里就能解决」的错误，所以就地给出口。
                越界（cwd_not_allowed）不给按钮：建了还是越界，服务端照样拒 */}
            {err.code === 'cwd_not_found' && canWrite && (
              <button type="button" className="ghost err-fix" onClick={createDirThenSession} disabled={busy}>
                建一个，然后开始
              </button>
            )}
          </p>
        )}

        <div className="new-composer">
          {/* 缩略图条在输入框上方，和会话页同一个位置、同一个形状 */}
          <DraftAttachments
            items={staged.map((it) => ({
              name: it.file.name || '文件',
              bytes: it.file.size,
              previewUri: it.preview,
              isImage: it.preview !== null,
            }))}
            onRemove={(i) => setStaged((prev) => {
              const gone = prev[i];
              if (gone?.preview) URL.revokeObjectURL(gone.preview);
              return prev.filter((_, j) => j !== i);
            })}
          />

          <InputBox
            value={draft}
            onChange={setDraft}
            onSubmit={() => create()}
            disabled={!cwd}
            sending={busy}
            placeholder={t('new.placeholder')}
            hasAttachments={staged.length > 0}
            /*
              选中只进缓存，**不上传**——会话还不存在，没有地方可落。
              真正上传在 create() 里，点发送那一刻。
            */
            onFiles={(files) => setStaged((prev) => [
              ...prev,
              ...files.map((f) => ({
                file: f,
                uploaded: null,
                preview: (f.type.startsWith('image/') || isImageName(f.name))
                  ? URL.createObjectURL(f)
                  : null,
              })),
            ])}
            pills={(
              <>
                <SessionConfig
                  mode="draft"
                  agent={agent}
                  onAgent={(a) => {
                    setAgent(a);
                    // claude 的模型名在 codex 上不成立，强度的可选集也不同
                    setModel(null);
                    setEffort(null);
                  }}
                  model={model}
                  onModel={setModel}
                  effort={effort}
                  onEffort={setEffort}
                />

                <div className="dirpill">
                  <button
                    type="button"
                    className={`pill${picking ? ' is-on' : ''}`}
                    aria-haspopup="dialog"
                    aria-expanded={picking}
                    onClick={() => setPicking(true)}
                  >
                    {/*
                      药丸上写的是**真正会用的那个目录**，不是选中的那个。
                      在顶上时它已经是即将新建的那个名字——发送之后才告诉人
                      「其实开在别处」是最糟的那种惊喜。
                      **不挂 title**：那会把宿主的绝对路径又漏出去。
                    */}
                    <span className="pill-mono">{cwd ? dirName(target) : t('new.pickDir')}</span>
                    <span className="chev" aria-hidden="true" />
                  </button>
                  {picking && (
                    <DirPicker
                      quick={cwds}
                      picked={cwd}
                      canWrite={canWrite}
                      // 选了具体目录之后的反悔出口：回到「自动新建那个」
                      resetTo={!atTop && topDir ? { dir: topDir, name: plan } : null}
                      onReset={() => {
                        setCwd(topDir!);
                        setAtTop(true);
                        setErr(null);
                        setPicking(false);
                      }}
                      onPick={(p) => {
                        setCwd(p);
                        setAtTop(false); // 先按「不是顶」渲染，checkTop 回来再纠正
                        checkTop(p);
                        setErr(null);
                      }}
                      onClose={() => setPicking(false)}
                    />
                  )}
                </div>
              </>
            )}
          />

          {/* 顶上不直接开工，所以会新建一个。**事先说，不是事后报告** */}
          {atTop && cwd && (
            <p className="compose-hint">
              {t('new.topHintPre')}<code>{plan}</code>{t('new.topHintMid')}<code>{dirName(cwd)}</code>{t('new.topHintPost')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useTheme, type Theme } from '@/theme';
import { IconBall } from '@/icons';
import { FloatBar, useFloatBarHeight } from '@/components/ui';
import { ScrollEdge } from '@/components/ScrollEdge';
import { DirSheet } from '@/components/DirSheet';
import { SetupPill } from '@/components/Setup';
import { Composer, PillSelect } from '@/components/Composer';
import { useModels } from '@/store/useModels';
import { Blocked } from '@/components/Notice';
import { Attachments } from '@/components/Attachments';
import { AttachMenu } from '@/components/AttachMenu';
import { useConnection } from '@/store/connection';
import { NEW_SESSION_DRAFT, useDraft } from '@/store/drafts';
import { BatonError } from '@/api/client';
import { watchCreation, type CreationReceipt } from '@/api/creationStatus';
import {
  stage, pickStaged, pickedFromFiles, uploadStagedToCwd, attachmentSuffix, type Staged,
} from '@/store/attach';
import type { Agent, Effort } from '@/api/types';
import { useLocale } from '@/i18n';

/**
 * 新会话 = **一个空的会话窗口，不是表单**。
 *
 * agent 和工作目录是输入框里的药丸（Claude 把模型选择器放在那儿），
 * 打字发出去才真正建会话——开窗口这一步不该问你任何问题。
 * 整屏只有 spike + 一句问候，别的什么都没有：**不做引导流程**。
 *
 * ## 工作目录的规则换过一次
 *
 * 旧规则是「只能选已有会话用过的目录」，客户端自己遍历 chains 凑候选。新规则是
 * 「绝对路径 ∧ 已存在 ∧ 在调用者的工作区之下」，候选由服务端给（`cwds`），
 * 还能真的浏览目录树。
 *
 * 换掉那段遍历不只是简化：它对 owner 恰好等价，但**访客零会话时凑出来的是空选单，
 * 压根开不了头**——而他本来就有一个工作区根目录可用。
 *
 * 这一页没有、也不该有任何「我是不是访客」的分支：服务端已经按调用者收窄过了。
 */
export default function NewScreen() {
  const t = useTheme();
  const router = useRouter();
  const client = useConnection((s) => s.client);
  const models = useModels();
  const { isEn, en } = useLocale();

  const [agent, setAgent] = useState<Agent>('claude');
  const [cwds, setCwds] = useState<string[]>([]);
  const [dir, setDir] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  // 新会话还没建，所以思考强度先留在本地，建的时候一并带上
  const [effort, setEffort] = useState<Effort | null>(null);
  const [dirSheet, setDirSheet] = useState(false);
  // 草稿存在这一屏之外，返回再进来还在（store/drafts.ts）。建成之后要清掉，
  // 否则下次点「新会话」又冒出上一条
  const [draft, setDraft] = useDraft(NEW_SESSION_DRAFT);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<(CreationReceipt & { client: typeof client; error?: string }) | null>(null);
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!receipt || !client || receipt.client !== client || receipt.error !== undefined) return;
    return watchCreation(receipt, client.creationStatus, (key) => {
      if (active.current && useConnection.getState().client === client) router.replace({ pathname: '/session/[key]', params: { key } });
    }, (error) => {
      if (active.current && useConnection.getState().client === client) setReceipt({ ...receipt, error });
    });
  }, [receipt, client, router]);
  const [err, setErr] = useState<{ msg: string; fix: string; code?: string } | null>(null);
  /**
   * 还没传上去的附件。**会话还不存在，所以字节只能先留在本地。**
   *
   * 离开这一屏就随组件一起消失，什么都不用清——那一刻一个字节都还没上传。
   * owner 要的「用户如果中途退出，就取消」是这个设计自带的，不是额外做的。
   */
  const [staged, setStaged] = useState<Staged[]>([]);
  const [attachSheet, setAttachSheet] = useState(false);
  const [attachAnchor, setAttachAnchor] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    client?.sessions().then((r) => {
      // 守一手：同仓一起发版，但守护进程是常驻的，owner 未必重启过。
      // 旧版没有 cwds，直接 .map 会在新建页上崩——那是最不该崩的一屏。
      const list = Array.isArray(r.cwds) ? r.cwds : [];
      setCwds(list);
      setDir((d) => d ?? list[0] ?? null);
    }).catch(() => {});
  }, [client]);

  /**
   * 发送 = 传文件 → 建会话 → 走。
   *
   * ## 为什么必须是这个顺序
   *
   * `createSession` 是「建会话 + 跑第一轮」一次做完的，而 agent **只认磁盘路径**，
   * 所以附件路径必须出现在第一条消息里。那就只能先把字节落到那个 cwd（走
   * `/api/uploads`，按目录而不是按会话——那一刻还没有 key），拿到相对路径，
   * 再带着路径建会话。
   *
   * ## 只发文件、不写字，是允许的
   *
   * owner：「第一条消息为什么不能是单纯发文件？」正文为空时，消息就是那段附件
   * 清单本身——它非空，服务端那条 `empty_message` 检查自然过，agent 也确实收到
   * 了它需要的东西（路径）。
   *
   * ## 上传成功但建会话失败
   *
   * 停在这一屏报错，并把**已经传成功的**记回 staged。人在原地再点一次发送时，
   * 那几个直接跳过——否则服务端同名不覆盖，会多出一堆 file-2.png。
   * 已经落盘的字节留在 `.baton-uploads/` 里（那本来就是暂存目录，文件浏览器里
   * 看得见）；为这点残留再开一个删除端点，不值得多一个写入面。
   */
  async function go() {
    const text = draft.trim();
    // 光有附件也能发——这一屏和会话屏的规则要一致
    if ((!text && !staged.length) || !dir || !client || busy) return;
    setBusy(true);
    setErr(null);
    try {
      let list = staged;
      if (list.length) {
        const r = await uploadStagedToCwd(client, dir, list);
        list = r.list;
        setStaged(list); // 先记下来，再决定要不要停——重试才跳得过已传的
        if (r.error) {
          setErr({
            msg: isEn ? en('new.uploadErr', { err: r.error }) : `有文件没传上去：${r.error}`,
            fix: isEn ? en('new.uploadFix') : '再点一次发送，已经传上去的不会重复传。',
          });
          return;
        }
      }
      const suffix = attachmentSuffix(list.flatMap((s) => (s.uploaded ? [s.uploaded] : [])));
      // 正文为空时就用附件清单本身当第一条消息（去掉它开头那两个换行）
      const message = text ? text + suffix : suffix.trimStart();
      const created = await client.createSession(agent, dir, message, model, effort);
      if (!active.current || useConnection.getState().client !== client) return;
      setDraft('');
      if (created.status === 'unconfirmed' && created.turnId) {
        setStaged([]);
        setReceipt({ turnId: created.turnId, statusUrl: created.statusUrl, client });
      } else if (created.key) {
        router.replace({ pathname: '/session/[key]', params: { key: created.key } });
      } else {
        router.replace('/');
      }
    } catch (e) {
      // code 留着：cwd_not_found 是「目录不存在」，那正好是问一句
      // 「要不要建一个」的时机，而不是让人回去自己找
      if (e instanceof BatonError) setErr({ msg: e.message, fix: e.fix, code: e.code });
      else setErr({ msg: (e as Error).message, fix: '' });
    } finally {
      setBusy(false);
    }
  }

  /** 「建一个」：建好目录就地重试，不用人再点一次发送。 */
  async function makeAndGo() {
    if (!client || !dir || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await client.makeDir(dir);
    } catch (e) {
      if (e instanceof BatonError) setErr({ msg: e.message, fix: e.fix, code: e.code });
      else setErr({ msg: (e as Error).message, fix: '' });
      setBusy(false);
      return;
    }
    setBusy(false);
    await go();
  }

  const hour = new Date().getHours();
  const greet = isEn
    ? (hour < 6 ? en('new.greetNight') : hour < 12 ? en('new.greetMorning') : hour < 18 ? en('new.greetAfternoon') : en('new.greetEvening'))
    : (hour < 6 ? '还没睡' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好');
  const s = styles(t);
  const barH = useFloatBarHeight();

  if (receipt && receipt.client === client) return (
    <KeyboardAvoidingView style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView contentContainerStyle={[s.hero, { paddingTop: barH }]}>
        <Text style={s.h1}>{receipt.error !== undefined
          ? receipt.error || (isEn ? 'This receipt is unavailable.' : '当前无法查看这张回执。')
          : isEn ? 'Checking whether Antigravity Desktop created your session…' : '正在核对 Antigravity 桌面端是否已建好会话…'}</Text>
        <Text selectable style={{ color: t.c.txTertiary }}>{isEn ? 'Request' : '查询编号'} {receipt.turnId}</Text>
      </ScrollView>
      <ScrollEdge height={barH} />
      <FloatBar onBack={() => router.back()} />
    </KeyboardAvoidingView>
  );
  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView contentContainerStyle={[s.hero, { paddingTop: barH }]}>
        <View style={s.heroMark}>
          <IconBall size={28} color={t.c.coral} />
        </View>
        <Text style={s.h1}>{greet}</Text>
      </ScrollView>

      {err ? (
        <View style={s.col}>
          <Blocked
            title={err.msg}
            fix={err.fix}
            // 只有「目录不存在」这一条能就地补救。越界（cwd_not_allowed）给按钮是
            // 骗人：建了也还是越界，服务端照样拒。
            action={err.code === 'cwd_not_found' ? { label: isEn ? en('new.createDir') : '建一个', onPress: makeAndGo } : undefined}
          />
        </View>
      ) : null}

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={go}
        sending={busy}
        disabled={!dir}
        placeholder={isEn ? en('new.placeholder') : '要它做什么'}
        /* 缩略图条：和会话屏同一个组件，只是这里的项还没有服务端路径 */
        above={(
          <Attachments
            items={staged}
            onRemove={(i) => setStaged((prev) => prev.filter((_, j) => j !== i))}
          />
        )}
        hasAttachments={staged.length > 0}
        /*
          网页端：加号底下压着一个真 input，文件从这儿直接进缓存（不上传）。
          原生端：加号弹我们那张卡片，选完再进缓存。两条都只到「缓存」为止，
          真正上传要等点发送——见 go()。
        */
        onFiles={(files) => setStaged((prev) => [...prev, ...stage(pickedFromFiles(files))])}
        onAttach={(a) => {
          setAttachAnchor(a);
          setAttachSheet(true);
        }}
        pills={
          <>
            {/*
              两颗，不是四颗。agent / 模型 / 思考强度 / 权限全并进「配置」——
              它们是同一件事的几个方面，而四颗药丸会把后两颗挤出屏幕外。
              工作目录单独留着：它是**内容**不是执行方式，选错等于在别的项目里
              开会话，和调模型不是一类事。
            */}
            <SetupPill
              agent={agent}
              onAgent={setAgent}
              model={model}
              modelOptions={models.for(agent)}
              onOpenModels={models.refresh}
              config={models.config(agent)}
              onModel={setModel}
              effort={effort}
              onEffort={setEffort}
            />
            <PillSelect
              label={dir ? dirName(dir) : (isEn ? en('new.pickDir') : '选目录')}
              mono
              onPress={() => setDirSheet(true)}
            />
          </>
        }
      />

      <ScrollEdge height={barH} />
      <FloatBar onBack={() => router.back()} />

      {/* 原生那张「拍照 / 照片 / 文件」卡片。网页端不弹它，系统自己会问 */}
      <AttachMenu
        open={attachSheet}
        anchor={attachAnchor}
        onClose={() => setAttachSheet(false)}
        onPick={(source) => {
          void (async () => {
            try {
              const picked = await pickStaged(source);
              if (picked.length) setStaged((prev) => [...prev, ...picked]);
            } catch (e) {
              // 权限被拒之类。只报出来，不清掉已经选好的那几个
              setErr({ msg: (e as Error).message, fix: '' });
            }
          })();
        }}
      />

      <DirSheet
        open={dirSheet}
        onClose={() => setDirSheet(false)}
        client={client}
        quick={cwds}
        current={dir}
        onPick={setDir}
      />
    </KeyboardAvoidingView>
  );
}

function dirName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.c.bgTertiary },
    col: { width: '100%', maxWidth: t.layout.contentMaxW, alignSelf: 'center' },
    hero: {
      flexGrow: 1, alignItems: 'center', justifyContent: 'center',
      gap: 16, paddingHorizontal: t.space.pad, paddingBottom: 70,
      width: '100%', maxWidth: t.layout.contentMaxW, alignSelf: 'center',
    },
    heroMark: {
      width: 58, height: 58, borderRadius: t.radius.full,
      backgroundColor: t.c.accentSoft,
      borderWidth: t.hairline,
      borderColor: t.isDark ? 'rgba(92,130,255,0.22)' : 'rgba(36,85,255,0.14)',
      alignItems: 'center', justifyContent: 'center',
    },
    h1: { fontFamily: t.fonts.serif, fontSize: 28, letterSpacing: -0.4, color: t.c.txPrimary },
  });

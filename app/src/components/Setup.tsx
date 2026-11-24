import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { PillSelect, Sheet, SheetP, Tappable } from './ui';
import { DetailRow, GroupH, SelectList, type Option } from './SelectList';
import { Segmented } from './Segmented';
import * as haptics from '@/feedback/haptics';
import { useConnection } from '@/store/connection';
import { usePermission } from '@/store/permission';
import { useLocale } from '@/i18n';
import type { Agent, AgentConfig, Effort, ModelOption, PermissionMode } from '@/api/types';

/**
 * 一颗按钮，一张面板，管完「这条消息会怎么被执行」的全部。
 *
 * ## 版式：分组列表 + 打勾，不是平铺按钮
 *
 * 上一版四节全是平铺的药丸按钮。owner：「哪有菜单是这样按钮直接摆出来的？
 * 你去看下别人怎么设计的」，并且发了 Claude App 的 Select model 和 GPT App 的
 * 配置两张截图。两个 App 的做法一致，也和 iOS 的通行规矩一致：
 *
 *   2 个、短标签       分段控件        ← Agent
 *   5–12 个、标签长    行 + 打勾       ← 模型
 *   要解释的           行 + 下钻子页   ← 思考强度、权限
 *
 * 平铺按钮的硬伤不是难看：**一排药丸放不下那句解释**。而这里最要紧的两节——
 * 模型（要带一句它是什么）和权限（每档的后果差别很大）——恰恰都需要解释。
 * 而且那排药丸横向滚动，第三颗之后默认在屏幕外，等于把设置藏起来。
 *
 * ## 子页面在同一块面板里切
 *
 * 不嵌套第二个 Modal（RN 上叠 Modal 有已知层级问题，而这块面板已经踩过
 * GlassView 的父级 opacity 那个坑）。`Sheet` 的 `onBack` 就是为此加的。
 *
 * ## 两个 harness 的档位**不通用**
 *
 * 权限和思考强度都由服务端按 agent 给：claude 有 plan、codex 有 read，
 * codex 的强度还逐模型不同（gpt-6-astra 到 ultra，gpt-5.5 封顶 xhigh）。
 * 客户端一个都不写死——写死就是在两处维护同一个事实。
 */

const AGENT_ITEMS = [['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'Antigravity']] as const;

/** 1000000 → 「100 万」。原样打一串零没人读得出量级。 */
function fmtTokens(n: number): string {
  if (n >= 10000) return `${Math.round(n / 10000)} 万 token`;
  return `${n} token`;
}

const EFFORT_NAME: Record<string, string> = {
  low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '超高',
};

/** 面板现在停在哪一页。子页面靠它切，不靠嵌套 Modal。 */
type Page = 'main' | 'model' | 'moreModels' | 'effort' | 'perm';

export function SetupPill({
  agent, onAgent, model, modelOptions, onModel, onOpenModels, effort, onEffort,
  config = { effort: null, contextWindow: null }, width, readOnlyPreferences = false,
}: {
  agent: Agent;
  /** 不传 = 这一屏不能换 agent（会话已经建在某个 agent 上了，换不了）。 */
  onAgent?: (a: Agent) => void;
  model: string | null;
  modelOptions: ModelOption[];
  onOpenModels: () => void;
  onModel: (m: string | null) => void;
  effort: Effort | null;
  onEffort: (e: Effort | null) => void;
  readOnlyPreferences?: boolean;
  /**
   * 这台电脑上已经配好的强度与上下文窗口。**如实转述，不做判断**——
   * owner：「我们只要保证正确读取用户的模型配置、思考强度、上下文窗口」。
   */
  config?: AgentConfig;
  /**
   * 面板内宽，给分段控件用——它不能自己量（见 Segmented 里 width 的注释）。
   *
   * 默认按屏宽减掉 sheet 的左右内边距算。App 锁竖屏（app.json 的
   * orientation: portrait），屏宽不变，所以这个数是确定的；调用方想覆盖再传。
   */
  width?: number;
}) {
  const t = useTheme();
  const s = styles(t);
  const { width: winW } = useWindowDimensions();
  const sheetW = width ?? Math.max(220, Math.min(winW || 390, t.layout.sheetMaxW) - t.space.pad * 2 - 2);
  const { isEn } = useLocale();
  const client = useConnection((c) => c.client);
  const perm = usePermission();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page>('main');
  const [ask, setAsk] = useState<PermissionMode | null>(null);

  useEffect(() => { usePermission.getState().refresh(client); }, [client]);
  // 每次重新打开都回到主页。停在上次那个子页上，等于让人先按一次返回
  useEffect(() => { if (open) setPage('main'); }, [open]);

  const here = perm.agents[agent];
  const permOption = here?.options.find((o) => o.id === here.mode) ?? null;

  const picked = model ? modelOptions.find((m) => m.id === model) ?? null : null;
  const shown = modelOptions.filter((m) => !m.hidden);
  const hiddenOnes = modelOptions.filter((m) => m.hidden);

  /**
   * 这个模型能选哪几档强度。
   *
   * 目录给了就用目录的（**逐模型不同**）；给不出来（Claude 侧没有目录）就退回
   * Claude CLI 文档里那五档。不给一个「设了却不生效」的值——那比设不了糟得多。
   */
  const efforts = useMemo<Effort[]>(() => {
    // 目录列着的模型，强度表是权威的——空表就是「不能调」，不退回五档
    if (picked?.listed || picked?.efforts.length) return picked.efforts;
    if (agent === 'claude' || agent === 'antigravity') return ['low', 'medium', 'high', 'xhigh', 'max'];
    // Codex 但没选具体模型：取所有候选的并集，至少不会漏掉能用的
    const all = new Set<Effort>();
    for (const m of modelOptions) for (const e of m.efforts) all.add(e);
    return [...all];
  }, [picked, agent, modelOptions]);

  /**
   * 「默认」现在实际是什么。owner：「默认模型也要显示到底是什么模型以及推理强度」。
   *
   * 强度分两种情况，不能混：
   *   没选模型  看默认模型自己拿到的那档。Claude 的默认强度是按模型定的
   *             （Opus 5.5 是「中」），配置文件里读不出来，是服务端问 CLI 问的
   *   选了模型  只有配置里写死的那档（Codex 的 model_reasoning_effort）对它也成立，
   *             其次是目录给的这个模型的默认。Claude 那边两样都没有，就如实说不知道
   */
  const dm = config.defaultModel ?? null;
  const defaultEffort: Effort | null = model
    ? config.effort ?? picked?.defaultEffort ?? null
    : dm?.effort ?? config.effort ?? null;
  const effortName = (e: Effort) => EFFORT_NAME[e] ?? e;

  const modelItems: Option<string>[] = [
    {
      id: '',
      label: '默认',
      body: dm
        ? `跟这台电脑的设置走，现在是 ${dm.name}`
          + `${dm.contextWindow ? ` · ${fmtTokens(dm.contextWindow)} 上下文` : ''}`
          + `${dm.effort ? ` · 强度「${effortName(dm.effort)}」` : ''}。`
        : '跟这台电脑上的设置走。',
    },
    /**
     * **不标「没跑过」。**
     *
     * 一度给没在 transcript 里出现过的模型加了这个标，理由是「选中它之后失败时
     * 人才知道该怀疑中转」。owner 否掉了，而且理由是产品边界不是显示细节：
     *
     *   我们产品是直接复用用户的配置，用户自己模型有问题和我们的产品没关系，
     *   我们只要保证正确读取用户的模型配置、思考强度、上下文窗口这些就可以了
     *
     * 那个标预设了「用户的配置可能不对」，而这件事本来就不归我们判断。
     * 我们的职责到「读对」为止。
     */
    ...shown.map((m) => ({ id: m.id, label: m.name, body: m.desc })),
  ];

  function pickPerm(id: PermissionMode) {
    const o = here?.options.find((x) => x.id === id);
    if (!o || !o.available || id === here?.mode) return;
    // 只有破坏性的那一档要二次确认。给可逆的几档也配确认只会养出闭眼点「好」
    // 的习惯，等真正危险的那次来了正好帮倒忙。
    if (o.danger) { setAsk(id); return; }
    usePermission.getState().set(client, agent, id);
  }

  const permValue = perm.known ? (permOption?.label ?? here?.mode ?? '—') : '…';

  return (
    <>
      <PillSelect
        label={isEn ? 'Config' : '配置'}
        // 药丸上只报**权限**这一项，因为只有它的取值会让人想立刻知道。
        // 模型名太长、思考强度不危险——全塞上去就成了一串谁也不看的字。
        dim={isEn && permValue === '默认' ? 'Default' : permValue}
        onPress={() => { setOpen(true); onOpenModels(); }}
        style={permOption?.danger ? s.hot : undefined}
      />

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={TITLE[page]}
        onBack={page === 'main' ? undefined : () => setPage(page === 'moreModels' ? 'model' : 'main')}
      >
        <ScrollView style={s.scroll} contentContainerStyle={s.scrollBody}>
          {page === 'main' ? (
            <>
              {onAgent ? (
                <>
                  <GroupH>Agent</GroupH>
                  <View style={s.segWrap}>
                    <Segmented
                      items={AGENT_ITEMS}
                      value={agent}
                      // 换 agent 要清掉模型和思考强度：claude-opus-5 填给 codex
                      // 一定跑不起来，而留着比清掉更糟——用户看见一个选中的值，
                      // 会以为它有效。权限不用清，它本来就是按 agent 存的。
                      onChange={(a) => { onAgent(a); onModel(null); onEffort(null); }}
                      width={sheetW}
                    />
                  </View>
                </>
              ) : null}

              <GroupH>模型</GroupH>
              {readOnlyPreferences ? <SheetP>{isEn ? 'Model and effort are read-only.' : '当前身份只能查看模型和思考强度。'}</SheetP> : null}
              <SelectList
                options={modelItems}
                disabled={readOnlyPreferences}
                value={model ?? ''}
                onPick={(id) => onModel(id || null)}
              />
              {hiddenOnes.length ? (
                <View style={s.gap}>
                  <View style={s.card}>
                    <DetailRow
                      label="更多模型"
                      value={`${hiddenOnes.length} 个`}
                      onPress={() => setPage('moreModels')}
                    />
                  </View>
                </View>
              ) : null}

              {config.contextWindow ? (
                /**
                 * 上下文窗口是**环境信息不是设置**，所以不做成可点的行。
                 * 报出来是因为 owner 要求「保证正确读取」——读到了就该看得见，
                 * 否则没人知道我们读没读对。
                 */
                <SheetP>这台电脑给 {agent === 'claude' ? 'Claude Code' : agent === 'antigravity' ? 'Antigravity' : 'Codex'} 配的上下文窗口：{fmtTokens(config.contextWindow)}</SheetP>
              ) : null}

              <View style={s.gap}>
                <View style={s.card}>
                  <DetailRow
                    label="思考强度"
                    // 「默认」后面跟上它现在实际是哪档——光两个字说不出会发生什么
                    value={picked?.listed && efforts.length === 0
                      ? '这个模型不能调'
                      : effort
                        ? effortName(effort)
                        : defaultEffort ? `默认 · ${effortName(defaultEffort)}` : '默认'}
                    onPress={() => setPage('effort')}
                  />
                  <DetailRow
                    label="权限"
                    value={permValue}
                    danger={!!permOption?.danger}
                    onPress={() => setPage('perm')}
                    first={false}
                  />
                </View>
              </View>
            </>
          ) : null}

          {page === 'moreModels' ? (
            <SelectList
              options={hiddenOnes.map((m) => ({ id: m.id, label: m.name, body: m.desc }))}
              disabled={readOnlyPreferences}
              value={model ?? ''}
              onPick={(id) => { onModel(id || null); setPage('main'); }}
            />
          ) : null}

          {page === 'effort' ? (
            <>
              <SelectList
                disabled={readOnlyPreferences}
                options={[
                  {
                    id: '',
                    label: '默认',
                    /**
                     * 报出它现在实际是哪档（defaultEffort 怎么定的见上面）。
                     * 「默认」两个字本身说不出会发生什么，等于让人自己去电脑上翻。
                     * 只有「选了模型、配置里又没写死」时，这个值才来自模型目录。
                     */
                    body: !defaultEffort
                      ? '跟模型自己的默认走。'
                      : model && !config.effort
                        ? `这个模型的默认是「${effortName(defaultEffort)}」。`
                        : `跟这台电脑的设置走，现在是「${effortName(defaultEffort)}」。`,
                  },
                  ...efforts.map((e) => ({ id: e, label: EFFORT_NAME[e] ?? e })),
                ]}
                value={effort ?? ''}
                onPick={(e) => { onEffort((e || null) as Effort | null); setPage('main'); }}
              />
              {picked ? (
                <SheetP>可选的档位由模型决定，换个模型可能多几档或少几档。</SheetP>
              ) : null}
            </>
          ) : null}

          {page === 'perm' ? (
            <>
              <SelectList
                options={(here?.options ?? []).map((o) => ({
                  id: o.id,
                  label: o.label,
                  body: o.body,
                  danger: o.danger,
                  disabled: !o.available || !perm.canSet,
                  why: o.unavailable,
                }))}
                value={here?.mode ?? null}
                onPick={pickPerm}
              />
              {!perm.canSet && perm.known ? (
                <SheetP>权限由那台电脑的主人设置，你这边只能看。</SheetP>
              ) : null}
              {/* 灰掉的原因说了，怎么修也得说——否则那几行就永远是灰的 */}
              {agent === 'codex' && perm.codexSandbox === 'missing' ? (
                <SheetP>
                  在那台电脑上用管理员身份跑一次 Codex，让它完成沙箱预置；
                  `codex doctor` 能看到状态。
                </SheetP>
              ) : null}
              {perm.err ? (
                <View style={s.err}>
                  <Text style={s.errTx}>{perm.err.msg}</Text>
                  {perm.err.fix ? <Text style={s.errFix}>{perm.err.fix}</Text> : null}
                </View>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      </Sheet>

      {/* 讲后果不讲机制——「不再询问」是机制，「它可以删文件、跑任何命令」才是你要衡量的 */}
      <Sheet open={ask !== null} onClose={() => setAsk(null)} title="全部放行？">
        <SheetP>
          {here?.options.find((o) => o.id === ask)?.body
            ?? '那台电脑上的 agent 将不再为任何操作停下来询问。'}
        </SheetP>
        <SheetP>
          没有有效期，开了就一直开，直到你回到这里改掉。开着的时候这颗药丸是红的。
        </SheetP>
        <Tappable
          style={s.confirm}
          haptic={haptics.thud}
          onPress={() => {
            if (ask) usePermission.getState().set(client, agent, ask);
            setAsk(null);
          }}
          accessibilityRole="button"
        >
          <Text style={s.confirmTx}>我知道，全部放行</Text>
        </Tappable>
      </Sheet>
    </>
  );
}

const TITLE: Record<Page, string> = {
  main: '这一轮怎么执行',
  model: '模型',
  moreModels: '更多模型',
  effort: '思考强度',
  perm: '权限',
};

const styles = (t: Theme) =>
  StyleSheet.create({
    hot: { backgroundColor: t.c.bgDanger },
    // 面板自己滚。封顶而不是撑满：下面要留出能点空白关掉的余地
    scroll: { maxHeight: 460 },
    scrollBody: { paddingBottom: 4 },

    // 分段控件要能鼓出自己的边界（长按时会胀大），所以这一层不能裁
    segWrap: { paddingHorizontal: 0 },
    card: { backgroundColor: t.c.bgSecondary, borderRadius: t.radius.xl, overflow: 'hidden' },
    gap: { marginTop: 18 },

    confirm: {
      marginTop: 14, minHeight: t.space.tap, borderRadius: t.radius.full,
      alignItems: 'center', justifyContent: 'center', backgroundColor: t.c.bgDanger,
    },
    confirmTx: {
      fontFamily: t.fonts.sans, fontSize: t.size.md,
      fontWeight: t.weight.bold, color: t.c.txDanger,
    },

    err: {
      marginTop: 10, paddingHorizontal: 14, paddingVertical: 10,
      borderRadius: t.radius.lg, backgroundColor: t.c.bgWarning,
    },
    errTx: {
      fontFamily: t.fonts.sans, fontSize: t.size.xs,
      fontWeight: t.weight.bold, color: t.c.txPrimary,
    },
    errFix: {
      fontFamily: t.fonts.sans, fontSize: t.size.xs, lineHeight: 18,
      color: t.c.txSecondary, marginTop: 2,
    },
  });

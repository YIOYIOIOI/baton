import { useCallback, useEffect, useState } from 'react';
import { useConnection } from '@/store/connection';
import type { Agent, AgentConfig, ModelList } from '@/api/types';

/**
 * 可选模型的来源。
 *
 * **这里只有取数**——选模型的界面在 Setup.tsx 那颗「配置」药丸里
 * （owner：「harness 选择，模型选择，思考强度选择，权限选择，全部放到一个
 * 按钮里面」）。原来那个 ModelSheet 组件连同它的文案一起删了，留着就是两套
 * 说法，而文案去重测试正好抓到了这一点。
 *
 * 这个文件原来就叫 components/ModelSheet.tsx，组件删掉之后只剩这个 hook、
 * 八个没人用的 import 和一整块没人用的样式，名字也不再说真话——2026-09-28
 * 挪到 store/，和 useSessionLive 放在一起。
 *
 * 列表**不写死**：这台电脑两边都走第三方中转，实际跑的是 claude-opus-5 /
 * gpt-6-astra 这种名字，官方模型表上一个都没有。所以由服务端从 transcript 和
 * 本地配置现推，客户端只负责显示。现推的列表永远可能漏（只扫最近 10 个会话），
 * 所以配置面板里保留了「跟这台电脑的默认」这一档兜底。
 */

/** 进程内缓存一次。模型表变动极少，而每进一个会话都重拉是白费一次往返。 */
let cached: ModelList | null = null;

export function useModels() {
  const client = useConnection((s) => s.client);
  const [data, setData] = useState(cached);

  useEffect(() => {
    if (!client || cached) return;
    client.models()
      .then((r) => { cached = r; setData(r); })
      // 拿不到就空表，UI 退回手输。这不是需要报错打断用户的事。
      .catch(() => {});
  }, [client]);

  const forAgent = useCallback(
    (a: Agent) => data?.[a] ?? [],
    [data],
  );

  /**
   * 这台电脑上已经配好的思考强度与上下文窗口，按 agent 给。
   * 没问到就当没配——不猜一个值填上。
   */
  const configFor = useCallback(
    (a: Agent): AgentConfig => data?.config?.[a] ?? { effort: null, contextWindow: null, defaultModel: null },
    [data],
  );

  return { for: forAgent, config: configFor, note: data?.note ?? null };
}

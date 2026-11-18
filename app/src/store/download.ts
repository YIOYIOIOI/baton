import { Platform, Share } from 'react-native';
import type { Client } from '@/api/client';

/**
 * 把会话工作目录里的一个文件**交到用户手上**。
 *
 * 「下载」这个词在两端意思完全不同，所以这里必须分叉——而且不是风格问题，是
 * 平台根本没有对应概念：
 *
 *   web     浏览器有下载这件事。造一个带 `download` 的 <a> 点一下就行。
 *           但**不能直接把地址挂上去**：那是个要带 Bearer 令牌的端点，而
 *           `<a href>` 不带自定义头。所以先 fetch 拿到 blob，再指向 blob URL。
 *
 *   iOS     **没有"下载文件夹"这个概念。** 系统给的对应动作是分享面板里的
 *           「存储到文件」。所以先把字节落到 App 的缓存目录，再把那个本地 uri
 *           交给 `expo-sharing`——之后存哪儿、发给谁由用户自己决定。
 *           直接 `Linking.openURL` 那个 http 地址是行不通的：Safari 拿不到
 *           Authorization 头，只会看到 401。
 *
 * 两个原生模块都用**动态 import**：web 打包时不该把它们拖进 bundle。
 */
export async function downloadSessionFile(
  client: Client, key: string, relPath: string, fileName: string,
): Promise<void> {
  const src = client.fileSource(key, relPath);

  if (Platform.OS === 'web') {
    const res = await fetch(src.uri, { headers: src.headers });
    if (!res.ok) throw new Error(`取不到这个文件（HTTP ${res.status}）`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻撤销会让部分浏览器来不及开始下载；给一拍
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }

  const [{ File, Paths }, Sharing] = await Promise.all([
    import('expo-file-system'),
    import('expo-sharing'),
  ]);

  const res = await fetch(src.uri, { headers: src.headers });
  if (!res.ok) throw new Error(`取不到这个文件（HTTP ${res.status}）`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  /**
   * 落在缓存目录，不落文档目录：这份只是「为了递给分享面板」的中转，
   * 用户真要留它会在面板里选「存储到文件」，那时系统自己会拷一份。
   * 放文档目录等于替他决定留一份，而且永远不会被清掉。
   */
  const target = new File(Paths.cache, fileName);
  try { target.delete(); } catch { /* 上次留下的同名文件，删不掉就覆盖 */ }
  target.create({ overwrite: true });
  target.write(bytes);

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('这台设备不支持分享，存不下来。');
  }
  await Sharing.shareAsync(target.uri);
}

export async function exportSessionMarkdown(client: Client, key: string): Promise<void> {
  const { filename, markdown } = await client.exportMarkdown(key);
  if (Platform.OS === 'web') {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }

  const [{ File, Paths }, Sharing] = await Promise.all([
    import('expo-file-system'),
    import('expo-sharing'),
  ]);
  const safeName = filename.replace(/[<>:"/\\|?*]+/g, '_');
  const target = new File(Paths.cache, safeName);
  try { target.delete(); } catch { /* overwrite below */ }
  target.create({ overwrite: true });
  target.write(markdown);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(target.uri, { mimeType: 'text/markdown', dialogTitle: safeName });
    return;
  }
  await Share.share({ title: safeName, message: markdown });
}

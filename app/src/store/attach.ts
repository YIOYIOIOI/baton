import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import type { Client } from '@/api/client';

/**
 * 选一个文件传到那台电脑。
 *
 * 传上去的文件**不会变成附件**——两个 CLI 在非交互模式下都只从磁盘按路径读文件，
 * 没有任何附件通道。所以这里做的是：把字节送到会话工作目录下的 .baton-uploads/，
 * 再把相对路径交给调用方贴进消息里。agent 认路径。
 *
 * 两个平台拿字节的方式不一样，而且都不能省：
 *   web     asset.file 就是个真 File（Blob），直接当 body 发
 *   native  只有 file:// uri，要用 expo-file-system 的 File 读出来
 * SDK 54 起 expo-file-system 换成了 File/Directory 类，readAsStringAsync
 * 那套在 57 上会直接抛——所以这里用 new File(uri).bytes()。
 */

/**
 * 传完之后界面要显示的那一条。
 *
 * `previewUri` 是**本地**的（web 上是 blob:、原生上是 file:），用来出缩略图——
 * 不回头去服务器取：文件刚从这台设备发出去，本地这份就是同一份，绕一圈没有意义，
 * 而且那需要再开一个「读取上传文件」的端点，白白多一个读取面。
 */
export type Attachment = {
  name: string;
  bytes: number;
  /** 相对工作目录的路径，发消息时带给 agent */
  relative: string;
  previewUri: string | null;
  isImage: boolean;
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|svg)$/i;

/**
 * 从哪儿拿这个文件。
 *
 * owner：「那个加号那里，点开后应该再弹出选框，选拍照还是照片还是附件」——
 * 原来点加号直接开文件选择器，想发张刚拍的照片得先去相机 app 拍完再回来找。
 * ChatGPT 和 Claude 的加号都是先给这三个。
 */
export type PickSource = 'camera' | 'library' | 'file';

/**
 * 相机和相册这两条**要先要权限**，而且要在真的去拿之前问。
 *
 * 不写成「先调再看报错」：iOS 上用户拒绝过一次之后，再调不会弹窗、直接返回取消，
 * 表现成「点了没反应」。拿到明确的拒绝才能告诉他去哪开。
 */
async function ensurePermission(source: PickSource): Promise<string | null> {
  if (source === 'file') return null;
  /**
   * **web 上一次都不要问。**
   *
   * 两条理由，第二条是硬的：
   *
   *   1  问了也白问——expo-image-picker 的 web 实现里这两个函数**永远返回
   *      granted**，注释原文："Camera roll permissions don't need to be
   *      requested on web"。
   *   2  它是个 `await`，而 web 上打开选择器靠的是**在用户手势里派发合成点击**，
   *      离手势越远越容易被 Safari 拒掉。这条路径上每一个能省的 await 都要省。
   */
  if (Platform.OS === 'web') return null;
  const r = source === 'camera'
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (r.granted) return null;
  return source === 'camera'
    ? '没有相机权限。到系统设置 → Baton 里打开。'
    : '没有相册权限。到系统设置 → Baton 里打开。';
}

/**
 * 三条来源最后都归一成「一个本地文件 + 一个名字」，后面的上传逻辑完全一样。
 *
 * `size` 是**选的时候**三个选择器都顺手给了的（DocumentPicker 叫 size、
 * ImagePicker 叫 fileSize、浏览器的 File 叫 size）。带上它是为了新建会话那一屏：
 * 文件在点发送之前只存在于缓存里，缩略图条要显示大小，而那时候还没有服务端
 * 回来的字节数。拿不到就 0——只影响那一行字。
 */
type Picked = { uri: string; name: string; mimeType?: string; file?: File; size?: number };

/**
 * 选文件。**一次可以选多个**。
 *
 * owner：「图片那里我只能单选，我一点一张图片就会再进入一个确认页，expo 那里面
 * 只需要点一次照片，然后在那个页面就可以一直多选然后点完成」。
 *
 * 根子上就是没开多选：`allowsMultipleSelection` 不传时默认 false，于是
 *   原生   PHPicker 选一张就直接回来
 *   web    `<input type="file">` 没有 `multiple`，只能选一个；而 iOS Safari
 *          对单选的 file input 还会多插一个确认页
 * 开了之后两端都变成「随便点，选完按完成」。
 *
 * 相机那条**不开多选**：拍照本来就是一次一张，开了也没有意义。
 */
async function pick(source: PickSource): Promise<Picked[]> {
  if (source === 'file') {
    const r = await DocumentPicker.getDocumentAsync({
      // 不限类型：限了就总有人要传的那一种恰好不在白名单里
      type: '*/*',
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (r.canceled || !r.assets?.length) return [];
    return r.assets.map((a) => ({
      uri: a.uri, name: a.name || 'file', mimeType: a.mimeType ?? undefined, file: a.file,
      size: a.size ?? undefined,
    }));
  }

  const opts: ImagePicker.ImagePickerOptions = {
    // 不给编辑界面：裁剪是在替他决定要发哪一块
    allowsEditing: false,
    // 不要 base64：那要多占 33% 内存，而我们本来就按 uri 读字节
    base64: false,
    quality: 1,
  };
  const r = source === 'camera'
    ? await ImagePicker.launchCameraAsync(opts)
    : await ImagePicker.launchImageLibraryAsync({
      ...opts, mediaTypes: ['images', 'videos'], allowsMultipleSelection: true,
    });
  if (r.canceled || !r.assets?.length) return [];

  // 相册给的 fileName 可能是空的（尤其 iCloud 上的原图），拿时间戳兜底：
  // 名字只影响电脑上那个文件叫什么，空着会变成 "file" 一堆同名。
  // 多选时还要加序号，否则同一批里几张无名图会互相顶掉名字。
  const stamp = Date.now();
  return r.assets.map((a, i) => ({
    uri: a.uri,
    name: a.fileName
      || `${source === 'camera' ? 'photo' : 'image'}-${stamp}${r.assets!.length > 1 ? `-${i + 1}` : ''}.jpg`,
    mimeType: a.mimeType ?? undefined,
    file: a.file as File | undefined,
    size: a.fileSize ?? undefined,
  }));
}

/**
 * 选 + 传。返回**这一批**全部传成功的附件。
 *
 * @param onPicking 用户选完、真正开始传那一刻调一次，参数是这一批有几个。
 *   给界面用：**「正在上传」的转圈只该在这之后出现**——在此之前人还在相册里翻，
 *   而那时候加号已经在转了（owner：「我还没上传图片那个加号就开始转圈」）。
 *
 * 多个文件**并发上传**，不是一个接一个：手机流量上单条连接跑不满，而 5 张
 * 图串行就是 5 个完整的往返（owner：「这个图片上传要好久啊」）。
 * 有一张失败不该把成功的那几张也丢掉，所以逐个收结果，最后统一报错。
 */
export type UploadBatch = { ok: Attachment[]; failed: number; error: string | null };

export async function pickAndUpload(
  client: Client, key: string, source: PickSource = 'file',
  onPicking?: (count: number) => void,
): Promise<UploadBatch> {
  const denied = await ensurePermission(source);
  if (denied) throw new Error(denied);

  const picked = await pick(source);
  if (!picked.length) return { ok: [], failed: 0, error: null }; // 用户取消了
  return uploadPicked(client, key, picked, onPicking);
}

/**
 * 浏览器给的 `File[]` 转成 `Picked[]`。
 *
 * `uri` 留空是**对的**：web 上 `bytesOf` 优先用 `file`，根本不看 uri。
 * 造一个 objectURL 塞进去反而要自己负责回收。
 */
export function pickedFromFiles(files: File[]): Picked[] {
  return files.map((f) => ({
    uri: '', name: f.name || 'file', mimeType: f.type || undefined, file: f, size: f.size,
  }));
}

/* ── 新建会话那一屏：文件先进缓存，点发送才真的传 ─────────────────────────── */

/**
 * 缩略图条只需要这四样。已经传上去的（`Attachment`）和还在缓存里的（`Staged`）
 * 都满足它，所以那条 UI 两种都能渲染，不用分叉。
 */
export type Thumb = {
  name: string;
  bytes: number;
  previewUri: string | null;
  isImage: boolean;
};

/**
 * 还没传上去的附件。
 *
 * owner：「文件为什么不能随着第一条消息发出去？或者说第一条消息为什么不能是
 * 单纯发文件？我感觉应该可以把文件做一个类似缓存，如果点击发送，那就建会话
 * 发出去，用户如果中途退出，就取消」。
 *
 * 只能这么做，不是选择：`createSession` 是「建会话 + 跑第一轮」一次做完的，
 * 而 agent 只认磁盘路径——路径必须在第一条消息里。所以字节得先留在本地，
 * 等点了发送才往那个 cwd 上传（`/api/uploads`），拿到路径再建会话。
 *
 * **中途退出什么都不用清**：那一刻一个字节都还没上传。这正是这个设计顺带的好处。
 */
export type Staged = Thumb & {
  picked: Picked;
  /**
   * 传成功之后填上。
   * 留着它是为了**重试不重复上传**：上传成功但建会话失败时，人在原地再点一次
   * 发送，已经传上去的那几个直接跳过——否则服务端同名不覆盖，会多出 file-2.png。
   */
  uploaded: Attachment | null;
};

/** 选中的文件进缓存。缩略图在这一步就能出，不用等上传。 */
export function stage(picked: Picked[]): Staged[] {
  return picked.map((p) => {
    const isImage = (p.mimeType ?? '').startsWith('image/') || IMAGE_EXT.test(p.name);
    return {
      picked: p,
      name: p.name,
      // 三个选择器都顺手给了大小，拿不到就 0——只影响缩略图上那行字
      bytes: p.size ?? 0,
      previewUri: isImage ? localPreview(p) : null,
      isImage,
      uploaded: null,
    };
  });
}

/** 上传之前的缩略图地址。web 上现造一个 objectURL，原生上 uri 本身就能用。 */
function localPreview(p: Picked): string | null {
  try {
    if (p.file) return URL.createObjectURL(p.file);
    return p.uri || null;
  } catch {
    return null; // 出不了缩略图不该挡住选文件
  }
}

/** 原生那条：先要权限、再开选择器、再入缓存。 */
export async function pickStaged(source: PickSource): Promise<Staged[]> {
  const denied = await ensurePermission(source);
  if (denied) throw new Error(denied);
  return stage(await pick(source));
}

/**
 * 把缓存里**还没传的**传到某个工作目录，而不是某个会话。
 *
 * 走 `/api/uploads`（按 cwd）而不是 `/api/sessions/<key>/upload`：这一刻会话
 * 还不存在。那个端点的授权判据与「能不能在这个目录建会话」逐条相同，
 * 所以它不多给任何权限——见 src/http/api.js 里 uploadToCwd 抬头那段。
 *
 * 返回更新后的整份列表：成功的带上 `uploaded`，失败的原样留着。**不抛**——
 * 调用方要能把成功的那几个记下来，好让重试跳过它们。
 */
export async function uploadStagedToCwd(
  client: Client, cwd: string, list: Staged[],
): Promise<{ list: Staged[]; error: string | null }> {
  const results = await Promise.allSettled(list.map(async (s): Promise<Staged> => {
    if (s.uploaded) return s; // 上一轮已经传成功了，跳过
    const data = await bytesOf(s.picked);
    const up = await client.uploadToCwd(cwd, s.picked.name, data);
    return {
      ...s,
      // 服务端可能因同名而改过名字，显示上跟着它
      name: up.name,
      bytes: up.bytes,
      uploaded: {
        name: up.name,
        bytes: up.bytes,
        relative: up.relative,
        previewUri: s.previewUri,
        isImage: s.isImage,
      },
    };
  }));

  const firstErr = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  return {
    list: results.map((r, i) => (r.status === 'fulfilled' ? r.value : list[i])),
    error: firstErr
      ? (firstErr.reason instanceof Error ? firstErr.reason.message : String(firstErr.reason))
      : null,
  };
}

/**
 * 「选」和「传」之间的那条缝。
 *
 * 拆出来是为了**网页端那条不经过选择器的路**：那边加号底下是一个真的
 * `<input type="file">`，文件由浏览器直接交到 onChange 手上，没有 `pick()`
 * 这一步（为什么不用 expo 的选择器，见 Composer.tsx 里加号那段）。
 */
export async function uploadPicked(
  client: Client, key: string, picked: Picked[],
  onPicking?: (count: number) => void,
): Promise<UploadBatch> {
  if (!picked.length) return { ok: [], failed: 0, error: null };
  onPicking?.(picked.length);

  const results = await Promise.allSettled(picked.map(async (a) => {
    const data = await bytesOf(a);
    const up = await client.upload(key, a.name, data);
    const isImage = (a.mimeType ?? '').startsWith('image/') || IMAGE_EXT.test(up.name);
    return {
      name: up.name,
      bytes: up.bytes,
      relative: up.relative,
      previewUri: isImage ? previewUriFor(a, data) : null,
      isImage,
    } satisfies Attachment;
  }));

  const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = results.length - ok.length;
  /**
   * **部分失败不抛。**
   *
   * 抛的话调用方只有两条路：要么丢掉已经传成功的那几张，要么去解构一个挂在
   * Error 上的载荷——两个都不好。直接把结果和失败数一起交出去，由界面决定
   * 怎么说。全军覆没时把第一条真错误一并带上，那句话才指向根因。
   */
  const firstErr = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  return {
    ok,
    failed,
    error: firstErr
      ? (firstErr.reason instanceof Error ? firstErr.reason.message : String(firstErr.reason))
      : null,
  };
}

/** web 上 File 可以直接 createObjectURL；原生上 asset.uri 本身就能当 Image 的 source。 */
function previewUriFor(a: Picked, data: Blob | Uint8Array): string | null {
  try {
    // web 上 bytesOf 必然返回 Blob（asset.file 或 res.blob()），所以这个判断
    // 同时也是在收窄类型——不用把 Uint8Array 硬塞进 new Blob()，那在 TS 的
    // BlobPart 定义下不成立（SharedArrayBuffer 的可能性）。
    if (data instanceof Blob) return URL.createObjectURL(data);
    // 原生：asset.uri 本身就是 Image 能直接用的 file:// 地址
    return a.uri ?? null;
  } catch {
    return null; // 出不了缩略图不该让整次上传失败
  }
}

async function bytesOf(a: Picked): Promise<Blob | Uint8Array> {
  if (Platform.OS === 'web') {
    // web 上 asset.file 是真 File。没有它（少数浏览器）就退回 uri 自取，
    // 而不是去解 base64——base64 要多占 33% 内存，大文件上很要命。
    if (a.file) return a.file;
    const res = await fetch(a.uri);
    return res.blob();
  }
  // 动态 import：web 打包时不该把原生文件系统模块拖进去
  const { File } = await import('expo-file-system');
  return new File(a.uri).bytes();
}

/**
 * 发送时附在正文后面的那段路径说明。
 *
 * **不再预先塞进输入框**——owner 的原话：「上传图片不要自动带上提示词」。
 * 之前那样做等于替他决定了这一轮说什么，而且他改完字还得绕开那句话。
 * 现在附件在输入框上方以缩略图出现，路径在**发送那一刻**才拼到正文末尾：
 * agent 只认磁盘路径，不给它路径它就看不见这个文件。
 */
export const ATTACH_HEADING = '附件（已放在工作目录下）：';

export function attachmentSuffix(list: Attachment[]): string {
  if (!list.length) return '';
  const lines = list.map((a) => `- ${a.relative}（${fmtBytes(a.bytes)}）`);
  return `\n\n${ATTACH_HEADING}\n${lines.join('\n')}`;
}

/** 从一条消息里摘出来的一个附件。`label` 是文件名，不含目录。 */
export type SentFile = { relative: string; label: string; isImage: boolean };

/**
 * 把消息正文和末尾那段附件清单**拆开**。
 *
 * 那段清单是写给 agent 的：两个 CLI 都只认磁盘路径，不给路径它就看不见文件
 * （见 `docs/ops/agent-protocol.md`）。但它**不该给人看**——owner 原话：
 * 「不要带上那个"附件：已放在"那个是给 agent 看的不是给我看的」。
 *
 * 所以渲染时在这儿切一刀：正文照常显示，清单换成缩略图/文件片。
 * **不改发送的内容**——agent 那边必须原样收到，改了它就读不到文件。
 *
 * 认的是 `attachmentSuffix()` 自己写出去的那个格式，不做通用解析：
 * 用户正文里恰好出现同样一行的概率不为零，所以要求它**出现在末尾**、
 * 且后面每一行都是 `- 路径（大小）`。任一条不满足就整段当正文，宁可多显示
 * 也不要吞掉用户真写的字。
 *
 * 路径那一段是 `(.+?)` 而不是 `(\S+)`：服务端的 `safeName` **不删空格**，
 * `我的 文件.txt` 是合法落盘名。用 `\S+` 的话这一行解析不了，于是整段清单
 * 会被当成正文显示给人看——正好是这段逻辑要避免的那件事。
 */
export function splitAttachments(text: string): { body: string; files: SentFile[] } {
  const marker = `\n\n${ATTACH_HEADING}\n`;
  const head = `${ATTACH_HEADING}\n`;

  /*
    两种形状都要认：
      正文 + "\n\n" + 抬头 + 清单   —— 有正文的时候
      抬头 + 清单                   —— **只发文件、一个字没写**

    后一种是发送方 `suffix.trimStart()` 出来的。只认前一种的话，纯附件消息
    的清单会原样显示给人看——而「第一条消息可以只是几个文件」正是刚加的能力。
  */
  const at = text.lastIndexOf(marker);
  const from = at >= 0 ? at + marker.length : (text.startsWith(head) ? head.length : -1);
  if (from < 0) return { body: text, files: [] };
  const bodyEnd = at >= 0 ? at : 0;

  const lines = text.slice(from).split('\n').filter((l) => l.trim());
  const files: SentFile[] = [];
  for (const line of lines) {
    const m = /^-\s+(.+?)（[^）]*）$/.exec(line.trim());
    if (!m) return { body: text, files: [] }; // 有一行不认识就整段当正文
    const relative = m[1];
    const label = relative.split(/[\\/]/).pop() || relative;
    files.push({ relative, label, isImage: IMAGE_EXT.test(relative) });
  }
  if (!files.length) return { body: text, files: [] };
  return { body: text.slice(0, bodyEnd), files };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

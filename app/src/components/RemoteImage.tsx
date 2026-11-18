import { useEffect, useState } from 'react';
import {
  Image, Platform, StyleSheet, View, type StyleProp, type ImageStyle,
} from 'react-native';
import { useTheme } from '@/theme';
import { useConnection } from '@/store/connection';

/**
 * 一张需要带令牌才能取到的图。
 *
 * 两端拿法不同，而且都不能省：
 *
 *   原生   `<Image source={{ uri, headers }}>`——下载、缓存、按需解码全交给它。
 *          这是最省的一条：图片字节从不进 JS 内存。
 *   网页   `<img>` **带不了自定义请求头**，所以只能先 fetch 拿字节、转成
 *          object URL 再喂给它。多占一份内存，但没有别的办法。
 *
 * 取不到就什么都不画（返回一块占位底）——一张出不来的缩略图不该把整条消息搞垮。
 */
export function RemoteImage({
  sessionKey, name, style,
}: {
  sessionKey: string;
  /** 文件名，不含目录。服务端只认文件名，见 src/upload.js 的 readUpload。 */
  name: string;
  style?: StyleProp<ImageStyle>;
}) {
  const t = useTheme();
  const client = useConnection((s) => s.client);
  const [webUri, setWebUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const source = client?.uploadSource(sessionKey, name) ?? null;

  useEffect(() => {
    if (Platform.OS !== 'web' || !source) return undefined;
    let alive = true;
    let objectUrl: string | null = null;
    fetch(source.uri, { headers: source.headers })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(b);
        setWebUri(objectUrl);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => {
      alive = false;
      // 不撤销会一直占着内存，直到整页卸载
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // uri 变了才重取；headers 每次渲染是新对象，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.uri]);

  if (!source || failed || (Platform.OS === 'web' && !webUri)) {
    return <View style={[style, styles.blank, { backgroundColor: t.c.bgSecondary }]} />;
  }

  return (
    <Image
      source={Platform.OS === 'web' ? { uri: webUri as string } : source}
      style={style}
      resizeMode="cover"
      onError={() => setFailed(true)}
    />
  );
}

const styles = StyleSheet.create({
  blank: { overflow: 'hidden' },
});

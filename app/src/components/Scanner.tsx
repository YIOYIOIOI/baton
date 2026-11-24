import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useTheme, type Theme } from '@/theme';
import { IconBack } from '@/icons';
import * as haptics from '@/feedback/haptics';

/**
 * 扫码配对。
 *
 * **为什么非得在 app 里扫，而不是用系统相机扫。**
 * iOS 上「添加到主屏」的应用与 Safari 是**两套独立的存储**：cookie、
 * localStorage 都不互通。所以拿系统相机扫码 → 在 Safari 里配对成功 → 回到
 * 主屏应用，它照样是未配对的。owner 实测撞到的就是这个。
 * 配对必须发生在主屏应用自己的上下文里，也就是这一屏。
 *
 * 扫到的是完整链接（`https://主机/pair?c=码`），所以原生端连地址一起解决了——
 * 那边本来还得手打一次主机名。
 */
export function Scanner({
  open, onClose, onScan,
}: {
  open: boolean;
  onClose: () => void;
  onScan: (r: { code: string; origin: string | null }) => void;
}) {
  const t = useTheme();
  const s = st(t);
  const [perm, requestPerm] = useCameraPermissions();
  const [asked, setAsked] = useState(false);
  // 扫到一次就够。不锁的话相机每帧都在解，同一个码会连着触发十几次，
  // 而配对码是一次性的——第二次就已经是「无效或已被使用」了。
  const done = useRef(false);

  useEffect(() => {
    if (!open) { done.current = false; setAsked(false); return; }
    if (insecureWeb()) return; // 不安全上下文下请求权限只会静默失败
    if (!perm?.granted && !asked) { setAsked(true); requestPerm(); }
  }, [open, perm?.granted, asked, requestPerm]);

  const denied = perm && !perm.granted && !perm.canAskAgain;
  const insecure = insecureWeb();

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose}>
      <View style={s.screen}>
        {insecure ? (
          <View style={s.center}>
            <Text style={s.msg}>
              浏览器只在 HTTPS 下给相机权限，而现在是明文 http。{'\n\n'}
              用隧道那个 https 地址打开，或者手打那 12 位码。
            </Text>
          </View>
        ) : perm?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (done.current) return;
              const parsed = parseScanned(data);
              if (!parsed) return; // 不是 Baton 的码就当没看见，继续扫
              done.current = true;
              // 扫码时眼睛在取景框上，不在界面上——「认到了」必须靠触感说，
              // 否则人会继续举着手机对着码等
              haptics.tap();
              onScan(parsed);
            }}
          />
        ) : (
          <View style={s.center}>
            <Text style={s.msg}>
              {denied
                ? '相机被拒过了。去系统设置里找到 Baton，把相机权限打开。'
                : '正在请求相机权限…'}
            </Text>
          </View>
        )}

        {/* 取景框。不是装饰——没有它用户不知道该把码放在哪，来回找很久 */}
        {perm?.granted && !insecure ? (
          <View style={s.overlay} pointerEvents="none">
            <View style={s.frame} />
            <Text style={s.hint}>把电脑上那个码放进框里</Text>
          </View>
        ) : null}

        <Pressable style={s.close} onPress={onClose} accessibilityRole="button" accessibilityLabel="关闭">
          <IconBack size={20} color="#fff" />
        </Pressable>
      </View>
    </Modal>
  );
}

/**
 * 浏览器只在**安全上下文**里给相机：https、或 localhost。
 * 局域网明文 http（http://192.168.x.x:3002）不算，getUserMedia 直接不存在。
 * 不显式判的话用户点了扫码只会看到一片黑，毫无线索。
 */
function insecureWeb(): boolean {
  if (Platform.OS !== 'web') return false;
  const g = globalThis as typeof globalThis & { isSecureContext?: boolean };
  return g.isSecureContext === false;
}

/**
 * 解析扫到的内容。
 *
 * 正常情况是完整链接，但也接受**裸配对码**——万一码是别的途径生成的，
 * 或者 URL 被某个相机 app 加工过。多认一种格式的成本是三行，
 * 而少认一种的代价是用户扫了没反应，且完全不知道为什么。
 */
export function parseScanned(data: string): { code: string; origin: string | null } | null {
  const raw = String(data ?? '').trim();
  const clean = (v: string) => v.toUpperCase().replace(/[^A-Z2-9]/g, '');

  try {
    const u = new URL(raw);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
    const c = clean(u.searchParams.get('c') ?? '');
    if (c.length === 12) return { code: c, origin: u.origin };
  } catch {
    // 不是 URL，往下当裸码试
  }

  const bare = clean(raw);
  return bare.length === 12 && bare === raw.toUpperCase() ? { code: bare, origin: null } : null;
}

const st = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: '#000' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
    msg: {
      color: '#fff', fontSize: t.size.md, lineHeight: 26,
      textAlign: 'center', fontFamily: t.fonts.sans,
    },
    overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 20 },
    frame: {
      width: 230, height: 230, borderRadius: t.radius.xl,
      borderWidth: 2, borderColor: t.c.coral,
    },
    hint: {
      color: '#fff', fontSize: t.size.sm, fontFamily: t.fonts.sans,
      backgroundColor: 'rgba(0,0,0,0.45)',
      paddingHorizontal: 14, paddingVertical: 8, borderRadius: t.radius.full,
    },
    close: {
      position: 'absolute', top: 52, left: 16,
      width: 40, height: 40, borderRadius: t.radius.full,
      backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
    },
  });

import { useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { IconFile, IconClose } from '@/icons';
import { fmtBytes, type Thumb } from '@/store/attach';

/**
 * 输入框上方那一排附件。
 *
 * 图片出缩略图、其余出文件卡片，每个右上角一个叉可以撤掉。这是 Claude / ChatGPT
 * 手机端的做法，也是 owner 点名要的：「图片要以缩略图出现在对话框上方」。
 *
 * 撤掉只是**不再随这条消息发出**——文件已经在那台电脑的 .baton-uploads/ 里了，
 * 这里删不掉它，也不该假装删得掉。文案不写「删除」写「不带上」。
 */
export function Attachments({
  items, onRemove,
}: { items: Thumb[]; onRemove: (i: number) => void }) {
  const t = useTheme();
  const s = at(t);
  /**
   * 点开看大图。**只有图片能点**——文件卡片上那点信息已经全在卡片上了，
   * 点开一个放大的文件图标没有意义。
   *
   * 预览用的是**本地**那份（previewUri），不回头去服务器取：文件刚从这台设备
   * 传出去，本地这份就是同一份，绕一圈只是多开一个读取面。
   */
  const [preview, setPreview] = useState<number | null>(null);

  if (!items.length) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={s.strip}
      contentContainerStyle={s.stripInner}
    >
      {items.map((a, i) => (
        <View key={`${a.name}-${i}`} style={s.item}>
          {a.isImage && a.previewUri ? (
            <Pressable
              onPress={() => setPreview(i)}
              accessibilityRole="imagebutton"
              accessibilityLabel={`查看 ${a.name}`}
            >
              <Image source={{ uri: a.previewUri }} style={s.thumb} resizeMode="cover" />
            </Pressable>
          ) : (
            <View style={[s.thumb, s.fileCard]}>
              <IconFile size={17} color={t.c.txTertiary} />
              <Text style={s.fileName} numberOfLines={2}>{a.name}</Text>
              <Text style={s.fileSize}>{fmtBytes(a.bytes)}</Text>
            </View>
          )}
          <Pressable
            style={s.x}
            onPress={() => onRemove(i)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`不带上 ${a.name}`}
          >
            <IconClose size={11} color={t.c.txInverse} />
          </Pressable>
        </View>
      ))}
      {/*
        看大图。点哪儿都关——这一屏没有任何别的操作，给个关闭按钮只是多一个
        要瞄准的目标；系统相册的大图也是点一下就收。
      */}
      <Modal
        visible={preview !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPreview(null)}
        statusBarTranslucent
      >
        <Pressable style={s.lightbox} onPress={() => setPreview(null)} accessibilityLabel="关闭">
          {preview !== null && items[preview]?.previewUri ? (
            <Image
              source={{ uri: items[preview].previewUri as string }}
              style={s.full}
              // contain 而不是 cover：这一屏的目的就是看清整张，裁掉边缘是帮倒忙
              resizeMode="contain"
            />
          ) : null}
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const at = (t: Theme) =>
  StyleSheet.create({
    strip: { flexGrow: 0, marginBottom: 8 },
    stripInner: { flexDirection: 'row', gap: 10, paddingHorizontal: 2, paddingTop: 6, paddingRight: 8 },
    // 62 太小了，一眼认不出发的是哪张（owner：「预览图片大一点」）。
    // 86 是「一行放得下四张、仍不至于把输入框顶高一截」的折中；多了就横向滚。
    item: { width: 86, height: 86 },
    thumb: {
      width: 86, height: 86, borderRadius: t.radius.lg,
      backgroundColor: t.c.bgPrimary,
      borderWidth: t.hairline, borderColor: t.c.bdTertiary,
    },
    fileCard: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5, gap: 2 },
    fileName: {
      fontFamily: t.fonts.sans, fontSize: 10, lineHeight: 13,
      color: t.c.txSecondary, textAlign: 'center',
    },
    fileSize: { fontFamily: t.fonts.sans, fontSize: 9.5, color: t.c.txTertiary },
    // 看大图：整屏压黑，图居中。黑底不跟随主题——看图时周围越暗越好，
    // 这是系统相册和两家 App 的一致做法
    lightbox: {
      flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
      alignItems: 'center', justifyContent: 'center',
    },
    full: { width: '100%', height: '100%' },
    // 叉压在右上角外沿：压在缩略图里会挡住内容，而内容正是它存在的理由
    x: {
      position: 'absolute', top: -6, right: -6,
      width: 20, height: 20, borderRadius: t.radius.full,
      backgroundColor: t.c.bgInverse,
      alignItems: 'center', justifyContent: 'center',
    },
  });

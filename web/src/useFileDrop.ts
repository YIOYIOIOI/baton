import { useCallback, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';

/**
 * 往一片区域上拖文件。
 *
 * 两条必须做对，否则表现出来是「覆盖层乱闪」和「拖一段文字也弹出上传提示」：
 *
 * 1. **dragenter / dragleave 会从每个子元素冒上来。** 鼠标从对话区划过一个代码块，
 *    就是一次 leave 加一次 enter。用布尔量记状态必然闪——要记**层数**，
 *    归零才算真的离开。
 * 2. **只认文件。** 在页面里拖选一段文字同样触发 drag 事件，`types` 里是
 *    `text/plain`。不判这个的话，选中一句话拖一下就弹出「松手上传」。
 *
 * `dragover` 必须 preventDefault，否则浏览器的默认行为是**用新文件替换当前页面**
 * ——松手之后整个界面变成一张图片。
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const hasFiles = (e: ReactDragEvent) => {
    const t = e.dataTransfer?.types;
    return t ? Array.prototype.includes.call(t, 'Files') : false;
  };

  const onDragEnter = useCallback((e: ReactDragEvent) => {
    if (!hasFiles(e)) return;
    depth.current += 1;
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((e: ReactDragEvent) => {
    if (!hasFiles(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const onDragOver = useCallback((e: ReactDragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // 不拦的话松手会把页面整个换成那个文件
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length) onFiles(files);
    },
    [onFiles],
  );

  return { dragging, dropProps: { onDragEnter, onDragLeave, onDragOver, onDrop } };
}

/**
 * 给剪贴板里的图片起名。
 *
 * 截图粘贴过来的 File 多半**没有名字**（`name` 是空串或一律叫 image.png），
 * 而落点是用户的项目目录——一堆同名 image.png 谁也分不清是哪张。用时间戳。
 *
 * 不用中文名：这个名字会进 `.baton-uploads/`，而用户多半要在终端里敲它。
 */
export function pastedName(file: File): string {
  if (file.name && file.name !== 'image.png') return file.name;
  const ext = file.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
  const t = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `pasted-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}.${ext}`;
}

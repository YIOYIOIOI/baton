import {
  draftAttachments, draftText, setDraftAttachments, setDraftText, NEW_SESSION_DRAFT,
} from '../drafts';
import type { Attachment } from '../attach';

const file = (relative: string): Attachment => ({
  name: relative, bytes: 1, relative, previewUri: null, isImage: false,
});

/**
 * owner：「我打完字如果返回好像在回来的时候字会消失」。
 *
 * 原来草稿是会话屏的 useState，返回就卸载。现在存在屏幕之外——
 * 下面这组钉的就是「离开再回来，还是那份」。
 */
describe('草稿按会话存在屏幕之外', () => {
  test('离开再回来还是那份，不同会话互不串', () => {
    setDraftText('claude:A', '打了一半');
    setDraftText('codex:B', '另一条');
    // 「回来」= 重新挂载的屏幕按 key 再读一次
    expect(draftText('claude:A')).toBe('打了一半');
    expect(draftText('codex:B')).toBe('另一条');
    expect(draftText('claude:C')).toBe('');
  });

  test('发出去清空之后就没有了', () => {
    setDraftText('claude:A', 'x');
    setDraftText('claude:A', '');
    expect(draftText('claude:A')).toBe('');
  });

  test('新建会话那一屏有自己的一份', () => {
    setDraftText(NEW_SESSION_DRAFT, '新会话的第一句');
    expect(draftText(NEW_SESSION_DRAFT)).toBe('新会话的第一句');
    setDraftText(NEW_SESSION_DRAFT, '');
  });

  test('附件同样留着，也收函数式更新', () => {
    setDraftAttachments('claude:A', [file('.baton-uploads/a.png')]);
    setDraftAttachments('claude:A', (prev) => [...prev, file('.baton-uploads/b.png')]);
    expect(draftAttachments('claude:A').map((a) => a.relative))
      .toEqual(['.baton-uploads/a.png', '.baton-uploads/b.png']);
    setDraftAttachments('claude:A', []);
    expect(draftAttachments('claude:A')).toEqual([]);
  });

  test('没有附件时每次给同一个空数组', () => {
    // 选择器每次返回新的 [] 会让订阅它的组件无限重画
    expect(draftAttachments('claude:none')).toBe(draftAttachments('claude:none'));
  });
});

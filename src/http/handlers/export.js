import fs from 'node:fs';
import { buildSessionMarkdown, exportFilename } from '../../export.js';
import { errorBody } from '../errors.js';

/** Export the visible session's conversation history as a downloadable Markdown document. */
export function exportSession({ repo, key, res }) {
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  let size;
  try {
    size = fs.statSync(member.file).size;
  } catch {
    return { status: 404, body: errorBody('session_gone', '会话文件已不存在。', '返回列表刷新一次。') };
  }
  const md = buildSessionMarkdown(member, { size });
  const buf = Buffer.from(md, 'utf8');
  const asciiName = exportFilename(member.title || member.key).replace(/[^\x20-\x7E]/g, '-');
  const utf8Name = exportFilename(member.title || member.key);
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`,
    'X-Baton': '1',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, no-cache',
  });
  res.end(buf);
  return null;
}

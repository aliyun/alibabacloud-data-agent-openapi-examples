import { apiHttpError } from './api-error';

export interface SessionAttachment {
  id: string;
  name: string;
  relativePath: string;
  size: number;
}

/** The instance supplies the limit through its upload capability. */
export function validateAttachment(file: File, maxBytes: number): void {
  if (!file.size) throw new Error(`「${file.name}」是空文件`);
  if (file.size > maxBytes) {
    throw new Error(`「${file.name}」超过单文件上限（${maxBytes / (1024 * 1024)} MiB）`);
  }
}

export async function uploadSessionAttachment(
  daemonBase: string,
  sessionId: string,
  file: File,
  maxBytes: number,
  signal: AbortSignal,
): Promise<SessionAttachment> {
  validateAttachment(file, maxBytes);
  const response = await fetch(`${daemonBase}/openapi/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Attachment-Name': encodeURIComponent(file.name),
    },
    body: file,
    signal,
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok) throw apiHttpError(response.status, data, '上传文件失败');
  if (typeof data?.id !== 'string' || !/^[a-f0-9]{32}$/.test(data.id) || data.name !== file.name ||
      typeof data.relativePath !== 'string' ||
      !data.relativePath.startsWith(`upload/${sessionId}_${data.id}`) ||
      !/^(?:\.[A-Za-z0-9]{1,12})?$/.test(data.relativePath.slice(`upload/${sessionId}_${data.id}`.length)) ||
      data.size !== file.size) {
    throw new Error('上传服务返回了无效的附件信息');
  }
  return data;
}

import { spawnSync } from 'child_process';
import process from 'process';

export function copyToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;

  if (process.platform === 'win32') {
    const result = spawnSync('clip', { input: value, encoding: 'utf-8', shell: true });
    return result.status === 0;
  }

  if (process.platform === 'darwin') {
    const result = spawnSync('pbcopy', { input: value, encoding: 'utf-8' });
    return result.status === 0;
  }

  const xclip = spawnSync('xclip', ['-selection', 'clipboard'], { input: value, encoding: 'utf-8' });
  if (xclip.status === 0) return true;

  const xsel = spawnSync('xsel', ['--clipboard', '--input'], { input: value, encoding: 'utf-8' });
  return xsel.status === 0;
}

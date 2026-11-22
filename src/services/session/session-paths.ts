import { homedir } from 'node:os';
import { join } from 'node:path';

export function sessionStorageRoot(home = homedir()): string {
  return join(home, '.qhy-coding-agents');
}

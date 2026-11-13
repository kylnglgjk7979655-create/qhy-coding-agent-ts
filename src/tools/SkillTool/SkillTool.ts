import { z } from 'zod';
import { findCommand } from '../../cli/commands.js';
import type { SkillCatalogue } from '../../services/skills/skill-registry.js';
import type { ToolRegistry } from '../tool-registry.js';

/**
 * 注册单个 Skill 工具。按规范名称、显示名称或别名精确查找已注册 Skill；
 * 结果只表示调用成功并返回命中的规范名称，正文由后续注入路径提供。
 */
export function registerSkillTool(registry: ToolRegistry, skills: SkillCatalogue): void {
  registry.register({
    name: 'skill',
    concurrency: 'parallel',
    description: '按规范名称、显示名称或别名加载已注册 Skill；结果只表示调用成功，正文由后续消息提供。',
    inputSchema: z.object({ name: z.string().trim().min(1) }),
    execute: ({ name }) => {
      const record = findCommand(skills.skills, name);
      if (record === undefined) throw new Error(`Unknown skill: ${name}`);
      return { name: record.name };
    },
  });
}
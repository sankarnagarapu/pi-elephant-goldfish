import { Plugin } from '@opencode/plugin'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('../../skills/egm/SKILL.md', import.meta.url),
  'utf8',
);
const policy = source.slice(source.indexOf('\n---\n', 4) + 5).trim();

export default Plugin.define({
  id: 'pi-elephant-goldfish',
  async setup(ctx) {
    let enabled = true;

    await ctx.session.hook('context', (event) => {
      if (!enabled) return;
      event.system.push({ type: 'text', text: policy });
    });

    await ctx.command.transform((editor) => {
      editor.add({
        name: 'egm',
        description: 'EGM: on, off, or status (enabled by default)',
        execute: async ({ sessionID, prompt }) => {
          const action = typeof prompt?.text === 'string' ? prompt.text.trim() : '';
          const verb = action || 'status';
          if (!['on', 'off', 'status'].includes(verb)) {
            await ctx.session.synthetic({ sessionID, text: 'Usage: /egm [on|off|status]' });
            return;
          }
          if (verb !== 'status') enabled = verb === 'on';
          await ctx.session.synthetic({ sessionID, text: `Elephant-Goldfish: ${enabled ? 'on' : 'off'}` });
        },
      });
    });
  },
});

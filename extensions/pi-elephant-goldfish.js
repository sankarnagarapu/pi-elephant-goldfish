import { readFileSync } from 'node:fs';

export default function piElephantGoldfish(api) {
  const source = readFileSync(
    new URL('../skills/egm/SKILL.md', import.meta.url),
    'utf8',
  );
  const policy = source.slice(source.indexOf('\n---\n', 4) + 5).trim();
  let enabled = true;

  api.on('before_agent_start', (event) => {
    if (!enabled) return;
    return {
      systemPrompt: Array.isArray(event.systemPrompt)
        ? [...event.systemPrompt, policy]
        : `${event.systemPrompt}\n\n${policy}`,
    };
  });

  api.registerCommand('egm', {
    description: 'EGM: on, off, or status (enabled by default)',
    handler: async (args, ctx) => {
      const action = args.trim() || 'status';
      if (!['on', 'off', 'status'].includes(action)) {
        ctx.ui.notify('Usage: /egm [on|off|status]', 'warning');
        return;
      }
      if (action !== 'status') enabled = action === 'on';
      ctx.ui.notify(`Elephant-Goldfish: ${enabled ? 'on' : 'off'}`, 'info');
    },
  });
}

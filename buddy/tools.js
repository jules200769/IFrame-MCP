// Tools only the buddy has (on top of the shared ones in src/tools.js).
import { z } from 'zod';

export const LOOK_UNAVAILABLE =
  'Meekijken is niet beschikbaar: dat kan alleen in het buddy-venster (npm run buddy), niet met npm run buddy:server.';

export const LOOK = {
  name: 'look',
  needsBrowser: false,
  description:
    'Kijk mee: een schermopname van het Chrome-venster van de gebruiker (alleen lezen). Werkt ook als Chrome niet gekoppeld ' +
    'of niet bestuurbaar is, en toont alles wat op het scherm staat, ook elke iframe en volledig scherm. ' +
    'De pixels komen niet overeen met click_xy-coördinaten; gebruik snapshot/screenshot om te bedienen.',
  schema: z.object({
    window: z.string().optional().describe('deel van de venstertitel; standaard het Chrome-venster'),
  }),
  async run(session, { window }, ctx) {
    if (!ctx?.capture) throw new Error(LOOK_UNAVAILABLE);
    // With a connected tab, prefer the Chrome window that shows it.
    const hint = session?.connected && session.page && !session.page.isClosed() ? await session.page.title().catch(() => '') : '';
    const shot = await ctx.capture({ match: window, hint });
    return [
      { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
      { type: 'text', text: `Schermopname van "${shot.title}" (${shot.width}x${shot.height}).` },
    ];
  },
};

export const BUDDY_TOOLS = [LOOK];

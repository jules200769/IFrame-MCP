// "Look along": a screenshot of the user's Chrome window via the OS (desktopCapturer).
// Works without CDP, for every kind of iframe, player or fullscreen app: it only reads pixels.
// The buddy window itself uses content protection, so it is never in the picture.
import { desktopCapturer, screen } from 'electron';

const MAX_WIDTH = 1600;
const isChrome = (name) => /google chrome|chromium/i.test(name);

export function createCapture() {
  return async ({ match, hint } = {}) => {
    const d = screen.getPrimaryDisplay();
    const thumbnailSize = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize, fetchWindowIcons: false });
    const want = (match || process.env.BUDDY_CAPTURE_WINDOW || '').toLowerCase();
    const has = (s, part) => part && s.name.toLowerCase().includes(part.toLowerCase());
    const pick = want
      ? sources.find((s) => has(s, want))
      : sources.find((s) => isChrome(s.name) && has(s, hint)) || sources.find((s) => isChrome(s.name));
    if (!pick) {
      throw new Error(
        want
          ? `Geen venster met "${want}" in de titel gevonden.`
          : 'Geen Chrome-venster gevonden. Is Chrome geminimaliseerd? Geef anders window=<deel van de venstertitel> of zet BUDDY_CAPTURE_WINDOW.',
      );
    }
    let img = pick.thumbnail;
    if (img.isEmpty()) throw new Error(`Het venster "${pick.name}" levert geen beeld (geminimaliseerd?).`);
    if (img.getSize().width > MAX_WIDTH) img = img.resize({ width: MAX_WIDTH, quality: 'good' });
    const { width, height } = img.getSize();
    return { data: img.toJPEG(70).toString('base64'), title: pick.name, width, height };
  };
}

// The checklist that ships with every report (spec 9.2): what automated
// testing cannot see, written so a non-expert can do each check in minutes.

export interface ManualCheck {
  title: string;
  how: string;
}

export const MANUAL_CHECKS: readonly ManualCheck[] = [
  {
    title: "Use the site with only a keyboard",
    how: "Put the mouse aside. Press Tab to move forward, Shift+Tab to move back, Enter to follow links and Space to press buttons. Walk through your main paths (home to product to cart to checkout, and the contact form) and note anything you can't reach or can't operate.",
  },
  {
    title: "Check that you can always see where keyboard focus is",
    how: "While tabbing through a page, look for a visible outline or highlight on the element you're on. If it ever disappears (common on buttons, menu items and image links), that element needs a focus style.",
  },
  {
    title: "Check the focus order makes sense",
    how: "Tab through a page and watch where the highlight goes. It should follow the reading order: header, navigation, content, footer. If it jumps backwards, skips a section or lands in a closed menu, the order needs fixing.",
  },
  {
    title: "Look for a skip link",
    how: "Load the home page and press Tab once. A link such as \"Skip to content\" should appear. Press Enter and confirm you land past the navigation. If nothing appears, add one as the first item on every page.",
  },
  {
    title: "Listen to checkout and the contact form with a screen reader",
    how: "Turn on VoiceOver (Mac: Cmd+F5) or NVDA (Windows, free). Go through the contact form and the first checkout step. Every field should announce its name, every button its action, and you should be able to finish without looking at the screen.",
  },
  {
    title: "Check that form errors are announced",
    how: "Submit a form with a required field empty or an email address mistyped. The error should appear next to the field, be worded clearly, and be read aloud by a screen reader. Red color alone is not enough.",
  },
  {
    title: "Zoom the page to 200%",
    how: "In your browser press Ctrl and + (Cmd and + on a Mac) until the page shows 200%. Nothing should overlap, get cut off or require sideways scrolling, and every button should still be usable.",
  },
  {
    title: "Check moving content can be paused",
    how: "Find anything that moves on its own: carousels, background videos, animated banners. Each needs a visible pause or stop control, and nothing should flash more than three times a second.",
  },
  {
    title: "Check captions and transcripts",
    how: "Play every video with the sound off. Captions should appear and match what is said. For audio-only content, look for a written transcript on the same page.",
  },
  {
    title: "Read link text out of context",
    how: "Scan a page and read only the link text. \"Click here\", \"Read more\" and \"Learn more\" tell a screen reader user nothing. Each link should say where it goes, such as \"Read our returns policy\".",
  },
  {
    title: "Judge alt text quality, not just presence",
    how: "Open the page's images in your site editor and read the alt text. It should describe what matters about the image (\"Lavender soy candle in a glass jar, 8 oz\"), not the file name or a list of keywords.",
  },
  {
    title: "Check that color isn't the only signal",
    how: "Look at anything that uses color to mean something: required fields in red, a green 'in stock' dot, a chart legend. Each should also have text, an icon or a pattern so it works for people who can't see the color.",
  },
];

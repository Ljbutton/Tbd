// Plain-English dictionary for axe rule ids (spec 9.1). This copy is the paid
// product when no LLM key is configured and the safety net when Claude fails,
// so every entry is written for a non-technical site owner: second person,
// concrete, names who is affected. Rules with a litigation weight of 3 note
// that their category is among the most common in ADA web complaints.
//
// fixHtml transformers take axe's example markup (truncated to 600 chars, so
// possibly unclosed) and return a minimal corrected version. They use tolerant
// regexes rather than a DOM parser and never throw on realistic input.

import type { Effort } from "../types.js";

export interface RuleEntry {
  title: string;
  plainEnglish: string;
  whyItMatters: string;
  fixSteps: string[];
  effort: Effort;
  fixHtml?: (html: string) => string;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface OpeningTag {
  /** Offset of "<" in the source. */
  start: number;
  /** Offset just past ">" in the source. */
  end: number;
  /** Tag name as written. */
  name: string;
  /** Raw attribute text between the tag name and ">" (may be empty, may end in "/"). */
  attrs: string;
}

/** Finds the first opening tag, optionally restricted to the given tag names (case-insensitive). */
function findOpeningTag(html: string, names?: readonly string[]): OpeningTag | null {
  const pattern = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const name = match[1] ?? "";
    if (!names || names.some((n) => n.toLowerCase() === name.toLowerCase())) {
      return { start: match.index, end: match.index + match[0].length, name, attrs: match[2] ?? "" };
    }
  }
  return null;
}

/** Reads an attribute value from raw attribute text (quoted or bare); null when absent or valueless. */
function readAttr(attrs: string, attrName: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>/]+))`, "i");
  const match = pattern.exec(attrs);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function hasAttr(attrs: string, attrName: string): boolean {
  return new RegExp(`(?:^|\\s)${attrName}(?=[\\s=/>]|$)`, "i").test(attrs);
}

/** Returns attrs with the attribute set to value (replacing an existing one, keeping the "/" of a self-closing tag). */
function withAttr(attrs: string, attrName: string, value: string): string {
  const escaped = escapeAttr(value);
  const existing = new RegExp(`(^|\\s)${attrName}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>/]+)`, "i");
  if (existing.test(attrs)) {
    return attrs.replace(existing, `$1${attrName}="${escaped}"`);
  }
  const valueless = new RegExp(`(^|\\s)${attrName}(?=[\\s/]|$)`, "i");
  if (valueless.test(attrs)) {
    return attrs.replace(valueless, `$1${attrName}="${escaped}"`);
  }
  const selfClosing = /\s*\/\s*$/.test(attrs);
  const body = selfClosing ? attrs.replace(/\s*\/\s*$/, "") : attrs.replace(/\s+$/, "");
  return `${body} ${attrName}="${escaped}"${selfClosing ? " /" : ""}`;
}

function rebuildTag(html: string, tag: OpeningTag, attrs: string): string {
  return `${html.slice(0, tag.start)}<${tag.name}${attrs}>${html.slice(tag.end)}`;
}

/** Sets an attribute on the first matching opening tag; returns the input unchanged when no tag matches. */
function setAttrOnFirst(html: string, names: readonly string[] | undefined, attrName: string, value: string): string {
  const tag = findOpeningTag(html, names);
  if (!tag) return html;
  return rebuildTag(html, tag, withAttr(tag.attrs, attrName, value));
}

/** Text content of a fragment with tags and entities removed. */
function visibleText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-zA-Z#0-9]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Turns "first_name", "your-email", "firstName" or "email" into "First name", "Your email", "First name", "Email". */
function humanize(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!spaced) return "";
  const text = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}...` : text;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Locates the last closing tag for the element opened at `tag`, or null when the markup is unclosed. */
function findClosing(html: string, tag: OpeningTag): { start: number; end: number } | null {
  const pattern = new RegExp(`</${tag.name}\\s*>`, "gi");
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (match.index >= tag.end) last = match;
  }
  if (!last) return null;
  return { start: last.index, end: last.index + last[0].length };
}

/**
 * Gives a control (button, link, heading) an accessible name:
 * - an empty element gets the text inserted;
 * - an element whose only content is an <img> gets alt text on the image;
 * - anything else (icon fonts, SVG, hidden text) gets aria-label.
 */
function nameControl(html: string, text: string, options: { preferAriaLabel?: boolean } = {}): string {
  const tag = findOpeningTag(html);
  if (!tag) return html;
  const name = tag.name.toLowerCase();

  if (name === "input") {
    const type = (readAttr(tag.attrs, "type") ?? "text").toLowerCase();
    if (type === "image") return rebuildTag(html, tag, withAttr(tag.attrs, "alt", text));
    return rebuildTag(html, tag, withAttr(tag.attrs, "value", text));
  }

  const closing = findClosing(html, tag);
  const inner = closing ? html.slice(tag.end, closing.start) : html.slice(tag.end);
  const innerText = visibleText(inner);

  if (innerText === "" && inner.trim() === "") {
    const close = closing ? html.slice(closing.start) : `</${tag.name}>`;
    return `${html.slice(0, tag.end)}${escapeText(text)}${close}`;
  }

  const img = findOpeningTag(inner, ["img"]);
  if (innerText === "" && img && !options.preferAriaLabel) {
    const currentAlt = readAttr(img.attrs, "alt");
    if (currentAlt === null || currentAlt.trim() === "") {
      const fixedInner = rebuildTag(inner, img, withAttr(img.attrs, "alt", text));
      return `${html.slice(0, tag.end)}${fixedInner}${closing ? html.slice(closing.start) : ""}`;
    }
  }

  return rebuildTag(html, tag, withAttr(tag.attrs, "aria-label", text));
}

const NON_LABELABLE_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

/** Wraps a form field with a matching <label for> (adding an id when the field has none). */
function wrapWithLabel(html: string, defaultText: string): string {
  const tag = findOpeningTag(html, ["input", "select", "textarea"]);
  if (!tag) return html;
  const type = (readAttr(tag.attrs, "type") ?? "").toLowerCase();
  if (tag.name.toLowerCase() === "input" && NON_LABELABLE_TYPES.has(type)) return html;

  const id = readAttr(tag.attrs, "id");
  const name = readAttr(tag.attrs, "name");
  const placeholder = readAttr(tag.attrs, "placeholder");
  const title = readAttr(tag.attrs, "title");

  const fieldId = (id && id.trim()) || slug(name ?? "") || slug(type && type !== "text" ? type : "") || "field";
  const labelText =
    (placeholder && placeholder.trim()) ||
    (title && title.trim()) ||
    humanize(name ?? "") ||
    humanize(id ?? "") ||
    (type && type !== "text" ? humanize(type) : "") ||
    defaultText;

  const attrs = id && id.trim() ? tag.attrs : withAttr(tag.attrs, "id", fieldId);
  const rebuilt = rebuildTag(html, tag, attrs);
  return `<label for="${escapeAttr(fieldId)}">${escapeText(labelText)}</label>\n${rebuilt}`;
}

function addAlt(text: string, names: readonly string[]): (html: string) => string {
  return (html) => setAttrOnFirst(html, names, "alt", text);
}

function addAriaLabel(text: string, names?: readonly string[]): (html: string) => string {
  return (html) => setAttrOnFirst(html, names, "aria-label", text);
}

function fixDocumentTitle(html: string): string {
  const title = "<title>Page name | Site</title>";
  const existing = /<title\b[^>]*>[\s\S]*?<\/title\s*>/i;
  if (existing.test(html)) return html.replace(existing, title);
  const head = findOpeningTag(html, ["head"]);
  if (head) return `${html.slice(0, head.end)}\n  ${title}${html.slice(head.end)}`;
  const root = findOpeningTag(html, ["html"]);
  if (root) {
    const rest = html.slice(root.end);
    return `${html.slice(0, root.end)}\n<head>\n  ${title}\n</head>${rest.trim() ? `\n${rest.trimStart()}` : ""}`;
  }
  return `<head>\n  ${title}\n</head>\n${html}`;
}

function fixViewport(html: string): string {
  const tag = findOpeningTag(html, ["meta"]);
  if (!tag) return html;
  const content = readAttr(tag.attrs, "content") ?? "";
  const kept = content
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .filter((part) => {
      const [key = "", value = ""] = part.split("=").map((s) => s.trim().toLowerCase());
      if (key === "user-scalable") return false;
      if (key === "maximum-scale" && Number(value) < 5) return false;
      return true;
    });
  if (!kept.some((p) => p.toLowerCase().startsWith("width="))) kept.unshift("width=device-width");
  if (!kept.some((p) => p.toLowerCase().startsWith("initial-scale="))) kept.push("initial-scale=1");
  return rebuildTag(html, tag, withAttr(tag.attrs, "content", kept.join(", ")));
}

function fixTabindex(html: string): string {
  return html.replace(/(\stabindex\s*=\s*)(?:"(\d+)"|'(\d+)'|(\d+))/gi, (whole, prefix: string, a?: string, b?: string, c?: string) => {
    const value = Number(a ?? b ?? c ?? "0");
    return value > 0 ? `${prefix}"0"` : whole;
  });
}

const AUTOCOMPLETE_FIXES: Record<string, string> = {
  zip: "postal-code",
  zipcode: "postal-code",
  "zip-code": "postal-code",
  postcode: "postal-code",
  "postal code": "postal-code",
  phone: "tel",
  telephone: "tel",
  "phone-number": "tel",
  mobile: "tel",
  "e-mail": "email",
  emailaddress: "email",
  "email-address": "email",
  firstname: "given-name",
  "first-name": "given-name",
  "first name": "given-name",
  lastname: "family-name",
  "last-name": "family-name",
  "last name": "family-name",
  surname: "family-name",
  fullname: "name",
  "full-name": "name",
  address: "street-address",
  address1: "address-line1",
  address2: "address-line2",
  street: "street-address",
  city: "address-level2",
  state: "address-level1",
  province: "address-level1",
  country: "country-name",
  company: "organization",
  cardnumber: "cc-number",
  "card-number": "cc-number",
  creditcard: "cc-number",
  cvv: "cc-csc",
  cvc: "cc-csc",
  expiry: "cc-exp",
  "expiration-date": "cc-exp",
  birthday: "bday",
  dob: "bday",
  "date-of-birth": "bday",
};

function fixAutocomplete(html: string): string {
  const tag = findOpeningTag(html, ["input", "select", "textarea"]);
  if (!tag) return html;
  const current = readAttr(tag.attrs, "autocomplete");
  if (current === null) return html;
  const key = current.trim().toLowerCase();
  const replacement = AUTOCOMPLETE_FIXES[key] ?? (key === "" ? "off" : null);
  if (replacement === null) return html;
  return rebuildTag(html, tag, withAttr(tag.attrs, "autocomplete", replacement));
}

function addCaptionTrack(names: readonly string[]): (html: string) => string {
  return (html) => {
    const tag = findOpeningTag(html, names);
    if (!tag) return html;
    const track = `<track kind="captions" src="captions.vtt" srclang="en" label="English">`;
    const closing = findClosing(html, tag);
    if (closing) return `${html.slice(0, closing.start)}\n  ${track}\n${html.slice(closing.start)}`;
    return `${html.slice(0, tag.end)}\n  ${track}${html.slice(tag.end)}`;
  };
}

function fixEmptyHeading(html: string): string {
  const tag = findOpeningTag(html, ["h1", "h2", "h3", "h4", "h5", "h6"]);
  if (!tag) return html;
  return nameControl(html, "Section title");
}

// ---------------------------------------------------------------------------
// Dictionary
// ---------------------------------------------------------------------------

const COMMON_COMPLAINT = "among the most common issues cited in ADA website complaints";

export const RULES: Record<string, RuleEntry> = {
  "image-alt": {
    title: "Images are missing text descriptions",
    plainEnglish:
      "Some images on your site have no alt text, the short description a screen reader speaks in place of the picture. Anyone who can't see the image gets nothing, or hears the file name instead.",
    whyItMatters:
      `Blind and low-vision visitors who use a screen reader hear "image" or a file name like "IMG_2041.jpg" and have to guess what you were showing them. Missing alt text is ${COMMON_COMPLAINT}, partly because it is so easy to spot.`,
    fixSteps: [
      "Add an alt attribute to every <img> that carries meaning, describing what the image shows in one short sentence (for a product photo: what the product is, its color, its size).",
      'For purely decorative images (backgrounds, dividers, spacers), use alt="" so screen readers skip them.',
      "If the image is inside a link or button, the alt text should say where the link goes or what the button does, not what the picture looks like.",
      "On Shopify, WordPress, Squarespace and Wix the alt text field is in the image or media settings panel; check there before editing code.",
    ],
    effort: "hours",
    fixHtml: addAlt("Describe what the image shows", ["img"]),
  },

  "color-contrast": {
    title: "Text is too light against its background",
    plainEnglish:
      "Some text on your pages is too close in color to what sits behind it, so the letters don't stand out enough. It may look fine on your monitor, but on a phone in sunlight or to someone with tired or aging eyes it fades into the background.",
    whyItMatters:
      `People with low vision, color blindness, or simply older eyes can't read low-contrast text, and that includes a large share of customers over 50. Contrast problems are ${COMMON_COMPLAINT} because they affect nearly every page.`,
    fixSteps: [
      "Darken the text or lighten the background until regular text reaches a contrast ratio of at least 4.5:1 (3:1 for large headings). A safe pairing: color: #1f2937; background: #ffffff; /* 4.5:1 */",
      "Check the exact pair with a free contrast checker (search for \"WebAIM contrast checker\"), paste in both colors and adjust until it passes.",
      "Look for the same color in your theme settings or CSS variables so one change fixes every page instead of one element at a time.",
      "Don't rely on light gray captions, placeholder text, or text over photos without a darker overlay behind it.",
    ],
    effort: "hours",
    fixHtml: (html) => html,
  },

  label: {
    title: "Form fields have no label",
    plainEnglish:
      "Some fields in your forms aren't attached to a visible label, so nothing tells a screen reader what the box is for. Placeholder text inside the field doesn't count: it disappears as soon as someone starts typing and is often not read aloud.",
    whyItMatters:
      `Screen reader users hear "edit text" with no clue whether the box wants a name, an email, or a card number, and people who use voice control can't say "click Email" to reach it. Unlabeled form fields are ${COMMON_COMPLAINT}, and they block contact forms and checkout, the pages where a lost visitor costs you the most.`,
    fixSteps: [
      'Give the field an id and add a <label for="that-id"> element with the field\'s name, placed right before it.',
      'If you truly can\'t show a visible label (a search box with a magnifier icon, for example), add aria-label="Search" to the input instead.',
      "Keep placeholder text as a hint only, never as the sole label.",
      "Check every form on the site: contact, newsletter sign-up, login, checkout, and search.",
    ],
    effort: "hours",
    fixHtml: (html) => wrapWithLabel(html, "Field name"),
  },

  "button-name": {
    title: "Buttons have no readable name",
    plainEnglish:
      "Some buttons on your site contain only an icon, or nothing at all, so there is no text a screen reader can announce. The visitor hears just \"button\" and has to guess whether it opens the menu, closes a popup, or submits their order.",
    whyItMatters:
      `Blind visitors and people who navigate by voice can't tell one unlabeled button from another, so they can't open your cart, dismiss a cookie banner, or submit a form. Unnamed buttons are ${COMMON_COMPLAINT} because they stop people at the exact moment they try to act.`,
    fixSteps: [
      'Put the action in words inside the button, for example <button>Add to cart</button>. If the button must show only an icon, add aria-label="Add to cart" to the button.',
      'For a search button that shows a magnifier, use aria-label="Search". For a close button that shows an X, use aria-label="Close".',
      'If the button holds an <img>, give the image alt text that names the action, such as alt="Open menu".',
      'For <input type="submit"> or type="button", set a value, such as value="Send message".',
    ],
    effort: "minutes",
    fixHtml: (html) => nameControl(html, "Describe the action"),
  },

  "link-name": {
    title: "Links have no readable text",
    plainEnglish:
      "Some links on your site contain only an icon or an image with no description, so screen readers have nothing to read out except \"link\". Social media icons, logo links and image-only product links are the usual culprits.",
    whyItMatters:
      `Screen reader users often jump through a page by listing its links; an empty link shows up as "link" or the raw web address, which tells them nothing. Links without text are ${COMMON_COMPLAINT}, and they hide your most important navigation, from the logo to the cart.`,
    fixSteps: [
      'Add text inside the link or, when only an icon can be shown, add aria-label describing where it leads, for example aria-label="Northwind Candles on Instagram".',
      'For image links, give the <img> alt text that names the destination, such as alt="Home" on a logo link.',
      'Avoid text like "click here" or "read more" on its own; say what the visitor will get, such as "Read our shipping policy".',
      "Check the header, footer and social icons first: they appear on every page.",
    ],
    effort: "minutes",
    fixHtml: (html) => nameControl(html, "Describe where this link goes"),
  },

  "select-name": {
    title: "Dropdown menus have no label",
    plainEnglish:
      "Some drop-down menus on your site have no label attached, so a screen reader can't say what the visitor is choosing. It might be a country, a size or a shipping method, but the visitor only hears \"combo box\".",
    whyItMatters:
      `Screen reader and voice control users can't tell which dropdown they are in, which is a real problem in checkout where a wrong country or size means a lost sale or a return. Unlabeled dropdowns fall in the same form-labeling category that is ${COMMON_COMPLAINT}.`,
    fixSteps: [
      'Give the <select> an id and add a <label for="that-id"> right before it, such as <label for="size">Size</label>.',
      'If there is no room for a visible label, add aria-label="Size" to the <select> instead.',
      'Make the first option a real choice or a clear prompt like "Choose a size", not blank.',
    ],
    effort: "minutes",
    fixHtml: (html) => wrapWithLabel(html, "Choose an option"),
  },

  "input-image-alt": {
    title: "Image buttons have no description",
    plainEnglish:
      'Your site uses an image as a button (an <input type="image">) without alt text, so screen readers can\'t announce what pressing it does. Typically it\'s a search magnifier or a submit arrow.',
    whyItMatters:
      `Blind visitors hear "button" with no name and can't tell what will happen if they press it, so they skip it, and it's often the button that submits the form. Missing text on images and image buttons is ${COMMON_COMPLAINT}.`,
    fixSteps: [
      'Add alt text that names the action, such as alt="Search" or alt="Submit order".',
      "If the image is only decoration on a regular button, switch to a <button> with real text and a background image instead.",
    ],
    effort: "minutes",
    fixHtml: addAlt("Describe what this button does", ["input"]),
  },

  "html-has-lang": {
    title: "The page doesn't say what language it's in",
    plainEnglish:
      "Your pages don't declare their language in the <html> tag. Screen readers use that setting to pick the right voice and pronunciation, and without it English text can be read with the wrong accent or skipped.",
    whyItMatters:
      "A screen reader user may hear your page read in the wrong language, which turns clear copy into gibberish. Browsers and translation tools also use this attribute to offer a translation to visitors who need one.",
    fixSteps: [
      'Add lang="en" to the <html> tag (use "es", "fr", or the matching code if your site is in another language).',
      "On WordPress, Shopify and most builders the theme's main layout file sets this once for every page; look for the <html> tag there.",
      "If a page mixes languages, mark the other-language sections with their own lang attribute.",
    ],
    effort: "minutes",
    fixHtml: (html) => setAttrOnFirst(html, ["html"], "lang", "en"),
  },

  "document-title": {
    title: "Pages have no title",
    plainEnglish:
      "Some pages have no <title>, or an empty one. The title is the text that appears in the browser tab, in search results and in bookmarks, and it's the first thing a screen reader says when a page loads.",
    whyItMatters:
      "Screen reader users rely on the title to know which page they landed on and to tell your tabs apart; without it they hear the web address or nothing. Search engines use the same title, so fixing it also helps people find you.",
    fixSteps: [
      "Add a <title> inside <head> on every page that names the page first and the site second, for example <title>Contact us | Northwind Candles</title>.",
      'Make each title unique; "Home" on every page is as unhelpful as no title.',
      'Most site builders expose this as a "page title" or "SEO title" field; fill it in for each page.',
    ],
    effort: "minutes",
    fixHtml: fixDocumentTitle,
  },

  "frame-title": {
    title: "Embedded frames have no title",
    plainEnglish:
      "Your site embeds content in <iframe> elements (maps, videos, booking widgets) without a title. Screen readers announce a frame by its title, so an untitled one is just \"frame\".",
    whyItMatters:
      "Screen reader users can't tell whether a frame contains a map, a video or a payment form, so they don't know whether to go in. When the frame holds a store locator or a booking form, that's a lost customer.",
    fixSteps: [
      'Add a title attribute that says what the frame contains, such as title="Map showing our shop location" or title="Video: how our candles are poured".',
      "If you paste embed codes from YouTube, Google Maps or a booking tool, add the title to the <iframe> tag in the pasted code.",
    ],
    effort: "minutes",
    fixHtml: (html) => setAttrOnFirst(html, ["iframe", "frame"], "title", "Describe what this frame shows"),
  },

  "heading-order": {
    title: "Headings skip levels",
    plainEnglish:
      "Your headings jump levels, for example from the main heading (h1) straight to a small one (h4). Headings are the outline of a page, and skipping levels breaks that outline.",
    whyItMatters:
      "Screen reader users move through long pages by jumping from heading to heading, and a skipped level makes it sound like a section is missing. Choosing a heading size for its look instead of its place in the outline confuses that navigation.",
    fixSteps: [
      "Use heading levels in order: one h1 for the page title, h2 for main sections, h3 for subsections, and so on.",
      "If a heading was picked for its size, keep the correct level and change the size with CSS instead.",
      "Check templates and page builders, which often default to h4 or h5 for card titles.",
    ],
    effort: "hours",
  },

  "page-has-heading-one": {
    title: "Pages have no main heading",
    plainEnglish:
      "Some pages don't have a level-one heading (h1), the single heading that names what the page is about. Visitors can usually tell from the big text at the top, but the code doesn't mark it as the main heading.",
    whyItMatters:
      "Screen reader users often jump straight to the h1 to confirm they are on the right page and skip past the navigation. Without one, they land in the menu and have to read through everything to find the content.",
    fixSteps: [
      'Give every page exactly one <h1> that names the page, such as the product name or "Contact us".',
      "Don't make the logo the h1; the heading should describe the page, not the site.",
      'Site builders usually let you set the page title block as "Heading 1".',
    ],
    effort: "minutes",
  },

  list: {
    title: "Lists contain items that aren't list items",
    plainEnglish:
      "Some of your lists (<ul> or <ol>) contain elements other than list items, such as a <div> or a stray link directly inside the list. Screen readers count and announce list items, and the extra elements throw that off.",
    whyItMatters:
      'A screen reader user hears "list, 3 items" and then finds content that doesn\'t match, or content that is silently skipped. Menus and product grids built as lists are where this usually shows up.',
    fixSteps: [
      "Make sure every direct child of a <ul> or <ol> is an <li>; wrap other content in an <li> or move it outside the list.",
      "Put any wrapper <div> inside the <li>, not between the list and its items.",
    ],
    effort: "minutes",
  },

  listitem: {
    title: "List items sit outside a list",
    plainEnglish:
      "Some <li> elements aren't inside a <ul> or <ol>, often because a wrapper element was placed between them and the list. To a screen reader they aren't part of any list.",
    whyItMatters:
      'Screen reader users lose the "list, 5 items" announcement that tells them how many menu entries or products to expect, and they can\'t jump past the list as one unit.',
    fixSteps: [
      "Wrap the items in a <ul> (bulleted) or <ol> (numbered) so each <li> has a list as its direct parent.",
      "Remove any <div> or <span> that sits directly between the list and its items.",
    ],
    effort: "minutes",
  },

  "aria-required-attr": {
    title: "Custom controls are missing required settings",
    plainEnglish:
      "Some elements on your site are marked with an ARIA role (like a slider, checkbox or tab) but are missing the settings that role needs, such as whether the checkbox is checked or what value the slider is at.",
    whyItMatters:
      "Screen reader users hear the control's name but not its state, so they can't tell whether an option is on or off or what the slider shows. This usually comes from a theme or plugin that builds its own custom controls.",
    fixSteps: [
      'For each flagged element, add the attributes the role requires (for example aria-checked on role="checkbox", aria-valuenow on role="slider", aria-selected on role="tab") and update them when the state changes.',
      'Where possible, replace the custom control with the native HTML element (<input type="checkbox">, <input type="range">), which handles this for you.',
      "If the control comes from a plugin or theme, check for an update or report it to the vendor.",
    ],
    effort: "hours",
  },

  "aria-valid-attr-value": {
    title: "Accessibility settings point to the wrong value",
    plainEnglish:
      "Some elements have ARIA attributes with values that don't work, such as aria-labelledby pointing to an id that doesn't exist on the page, or aria-expanded set to something other than true or false.",
    whyItMatters:
      "Screen reader users get a blank name or a wrong state where the attribute was supposed to help them. A menu button that says it is expanded when it isn't leaves them opening and closing it with no feedback.",
    fixSteps: [
      'Check each flagged attribute: id references (aria-labelledby, aria-describedby, aria-controls) must match an id that exists on the page, and true/false attributes must be exactly "true" or "false".',
      "If the referenced element was removed or renamed, update or remove the attribute.",
      "Test the control with a screen reader (VoiceOver on Mac, NVDA on Windows) after the fix.",
    ],
    effort: "hours",
  },

  "aria-roles": {
    title: "Elements use roles that don't exist",
    plainEnglish:
      'Some elements carry a role attribute with a value that isn\'t a real ARIA role, often a typo like role="buton" or a made-up name from a plugin. Assistive technology ignores unknown roles, so the element loses the meaning you intended.',
    whyItMatters:
      "A screen reader user may hear a custom button as plain text, or a navigation area as nothing at all, so they can't find or operate it. The fix is usually a one-word correction.",
    fixSteps: [
      "Replace each invalid role with a valid one (button, link, navigation, dialog, tab, and so on), or remove the attribute if the native element already has the right meaning.",
      "Prefer native elements: a real <button> needs no role at all.",
    ],
    effort: "minutes",
  },

  "aria-hidden-focus": {
    title: "Hidden content can still receive keyboard focus",
    plainEnglish:
      'Some parts of your page are hidden from screen readers with aria-hidden="true" but still contain links or buttons that the keyboard can reach. Keyboard users land on something a screen reader says isn\'t there.',
    whyItMatters:
      "A screen reader user tabs onto an invisible control, hears nothing, and gets stuck or activates something by accident. Closed menus, carousels and cookie banners are the usual sources.",
    fixSteps: [
      'When you hide a region with aria-hidden="true", also stop its contents from receiving focus: add tabindex="-1" to the focusable elements, use the disabled attribute, or hide the whole region with display: none or the hidden attribute.',
      "For off-screen slides or closed menus, use display: none while they are not active.",
    ],
    effort: "hours",
  },

  "meta-viewport": {
    title: "Pinch-to-zoom is disabled on phones",
    plainEnglish:
      "Your pages tell mobile browsers not to let visitors zoom, using user-scalable=no or a maximum-scale in the viewport meta tag. On a phone, anyone who needs bigger text can't pinch to enlarge it.",
    whyItMatters:
      `People with low vision, and anyone reading without their glasses, rely on pinch-to-zoom to read small text and tap small buttons; disabling it locks them out on the device most of your customers use. Zoom restrictions are ${COMMON_COMPLAINT} against mobile sites.`,
    fixSteps: [
      'Change the viewport meta tag to <meta name="viewport" content="width=device-width, initial-scale=1">, removing user-scalable=no and any maximum-scale below 5.',
      "This tag lives in the theme's main layout file; one change fixes every page.",
      "If a plugin keeps adding it back, check the plugin's mobile settings or turn that option off.",
    ],
    effort: "minutes",
    fixHtml: fixViewport,
  },

  "autocomplete-valid": {
    title: "Form fields use invalid autofill settings",
    plainEnglish:
      'Some form fields have an autocomplete attribute with a value the browser doesn\'t recognize, such as autocomplete="zipcode" instead of "postal-code". The browser can\'t autofill the field, so the setting does nothing.',
    whyItMatters:
      "People with motor or memory difficulties, and anyone on a phone, depend on autofill to get through checkout without typing every field. Invalid values also stop assistive tools from knowing what kind of information the field wants.",
    fixSteps: [
      'Replace each invalid value with the standard token: name, email, tel, street-address, postal-code, cc-number, and so on (the full list is in the HTML standard under "autofill field names").',
      'If a field shouldn\'t be autofilled, use autocomplete="off" rather than a made-up value.',
    ],
    effort: "minutes",
    fixHtml: fixAutocomplete,
  },

  "duplicate-id-aria": {
    title: "The same id is used more than once",
    plainEnglish:
      "Some elements share the same id, and at least one of them is referenced by an accessibility attribute such as aria-labelledby or a <label for>. Ids must be unique, so the browser picks one and ignores the rest.",
    whyItMatters:
      'A label or description may end up attached to the wrong element, so a screen reader user hears "Email" on the phone field or nothing on the one that mattered. Repeated form sections and copy-pasted blocks are the usual cause.',
    fixSteps: [
      "Give each element a unique id (for example email-billing and email-shipping) and update every label for and aria-* reference that points to it.",
      "Check repeated components, such as the same newsletter form in the header and footer.",
    ],
    effort: "hours",
  },

  tabindex: {
    title: "Keyboard order is forced with positive tabindex",
    plainEnglish:
      'Some elements use a tabindex greater than zero (like tabindex="5") to force where they land in the keyboard order. This pulls them ahead of everything else on the page, so the Tab key jumps around instead of following the visual layout.',
    whyItMatters:
      "Keyboard-only users, including many people with motor disabilities, tab into a field in the middle of a form before the ones above it, then have to hunt for what they skipped. It's disorienting and easy to fix.",
    fixSteps: [
      'Replace positive tabindex values with tabindex="0" (or remove the attribute on elements that are already focusable, such as links, buttons and inputs).',
      "If the tab order still feels wrong, reorder the elements in the HTML so the code order matches the visual order.",
    ],
    effort: "minutes",
    fixHtml: fixTabindex,
  },

  "video-caption": {
    title: "Videos have no captions",
    plainEnglish:
      "Your site includes <video> elements without a captions track, so anyone who can't hear the audio misses what is said. Product demos, testimonials and \"about us\" videos are the usual cases.",
    whyItMatters:
      `Deaf and hard-of-hearing visitors get nothing from the video, and neither does anyone watching with the sound off on a phone. Missing captions are ${COMMON_COMPLAINT} involving video content.`,
    fixSteps: [
      "Create a captions file (WebVTT, .vtt) for each video; many editing tools and services generate one you can proofread.",
      'Add it to the video: <track kind="captions" src="captions.vtt" srclang="en" label="English">.',
      "If the video is hosted on YouTube or Vimeo, upload the captions there and make sure they are turned on in the embed.",
      "Provide a written transcript on the page for anyone who prefers to read.",
    ],
    effort: "days",
    fixHtml: addCaptionTrack(["video"]),
  },

  "audio-caption": {
    title: "Audio has no transcript",
    plainEnglish:
      "Your site includes <audio> elements (podcasts, music samples, voice messages) with no captions track or transcript, so anyone who can't hear misses the content entirely.",
    whyItMatters:
      `Deaf and hard-of-hearing visitors get nothing from the audio, and people in noisy or quiet places can't listen either. Missing captions and transcripts are ${COMMON_COMPLAINT} involving media.`,
    fixSteps: [
      'Provide a written transcript next to the player, or a captions track: <track kind="captions" src="transcript.vtt" srclang="en">.',
      "Link to the transcript from the same place the audio is embedded so people can find it.",
    ],
    effort: "days",
    fixHtml: addCaptionTrack(["audio"]),
  },

  "scrollable-region-focusable": {
    title: "Scrolling areas can't be reached by keyboard",
    plainEnglish:
      "Some content on your page sits inside a box that scrolls on its own (a product carousel, a terms box, a wide table) but the box can't be reached with the keyboard. Mouse users scroll it; keyboard users never see the content below the edge of the box.",
    whyItMatters:
      "Keyboard-only users and many screen reader users can't read the rest of the text or see the rest of the products in the scrolling area. If it's your terms of sale or a size chart, that's information they need before buying.",
    fixSteps: [
      'Add tabindex="0" to the scrolling container so keyboard users can focus it and scroll with the arrow keys.',
      'Give it an accessible name, such as aria-label="Size chart", so screen readers announce what it is.',
      "If the box doesn't need to scroll, remove the fixed height or overflow setting and let the page grow instead.",
    ],
    effort: "minutes",
    fixHtml: (html) => setAttrOnFirst(html, undefined, "tabindex", "0"),
  },

  "nested-interactive": {
    title: "Clickable elements are nested inside each other",
    plainEnglish:
      "Some interactive elements sit inside other interactive elements, for example a <button> inside an <a>, or a link inside a button. Browsers and assistive tools can't tell which one should respond, so keyboard and screen reader behavior becomes unpredictable.",
    whyItMatters:
      'A screen reader user may hear only the outer element and never reach the inner one, and keyboard users may find that Enter activates the wrong thing. Product cards with a link wrapping an "Add to cart" button are the typical source.',
    fixSteps: [
      'Take the inner control out of the outer one so they sit side by side, for example the product link and the "Add to cart" button as siblings in the card.',
      "If the whole card should be clickable, make the title the link and position the button separately.",
    ],
    effort: "hours",
  },

  "target-size": {
    title: "Tap targets are too small",
    plainEnglish:
      "Some buttons, links or icons on your pages are smaller than 24 by 24 pixels, or are packed so tightly that a fingertip covers two at once. Quantity steppers, close icons and pagination links are the usual offenders.",
    whyItMatters:
      "People with tremors, arthritis or larger fingers, and anyone on a bouncing bus, hit the wrong control or miss it entirely. Small targets cause mistaken taps in checkout, where an accidental minus instead of plus costs you an order.",
    fixSteps: [
      "Make each interactive element at least 24 by 24 CSS pixels (44 by 44 is more comfortable on phones), for example with min-width: 44px; min-height: 44px; padding: 8px.",
      "Add space between neighboring controls so two targets don't sit under one fingertip.",
      "Check icon-only buttons first: the icon can stay small as long as the clickable area around it is large enough.",
    ],
    effort: "hours",
  },

  "link-in-text-block": {
    title: "Links in paragraphs look like plain text",
    plainEnglish:
      "Some links inside paragraphs are shown only by a slight color change, with no underline or other visual cue. Readers who can't tell the two colors apart have no way to know the words are clickable.",
    whyItMatters:
      "About 1 in 12 men have some form of color blindness and can miss a link that differs from body text only by color, so they never find your shipping policy, size guide or sign-up page. The fix is a single CSS rule.",
    fixSteps: [
      "Underline links inside text: p a, li a { text-decoration: underline; }",
      "If you don't want underlines, make the link color contrast at least 3:1 against the surrounding text and add a second cue on hover and focus (such as an underline or a bold weight).",
    ],
    effort: "minutes",
  },

  "empty-heading": {
    title: "Headings have no text",
    plainEnglish:
      "Some heading elements (h1 to h6) on your site are empty, usually left over from a template or holding only an icon or an image without alt text. Screen readers announce a heading and then say nothing.",
    whyItMatters:
      "Screen reader users jump between headings to skim a page, and an empty one wastes a stop and hides what the section is about. Empty headings often mean a section title was styled as plain text elsewhere, so the outline is missing that entry too.",
    fixSteps: [
      "Put the section's title inside the heading, or remove the empty heading element entirely.",
      "If the heading holds an image, give the image alt text that states the heading.",
    ],
    effort: "minutes",
    fixHtml: fixEmptyHeading,
  },

  "role-img-alt": {
    title: "Custom images have no description",
    plainEnglish:
      'Some elements marked as images with role="img" (icon fonts, CSS background images, emoji spans) have no accessible name. Screen readers know it\'s an image but have nothing to say about it.',
    whyItMatters:
      `Blind and low-vision visitors hear "image" with no description, exactly as with a missing alt attribute, and icon fonts used for ratings, features or payment methods carry meaning your customers need. Missing image descriptions are ${COMMON_COMPLAINT}.`,
    fixSteps: [
      'Add aria-label with a short description to each role="img" element, for example aria-label="4 out of 5 stars".',
      'If the image is purely decorative, remove role="img" and add aria-hidden="true" instead.',
    ],
    effort: "minutes",
    fixHtml: addAriaLabel("Describe what the image shows"),
  },

  "svg-img-alt": {
    title: "SVG graphics have no description",
    plainEnglish:
      'Some inline SVG graphics on your site carry role="img" but no title or label, so screen readers can\'t describe them. Logos, icons and charts drawn as SVG are the usual cases.',
    whyItMatters:
      `Screen reader users hear "image" or "graphic" with no description, and if the SVG is your logo link or a payment icon they miss its meaning. Missing image descriptions are ${COMMON_COMPLAINT}.`,
    fixSteps: [
      'Add aria-label="Short description" to the <svg> element, or add a <title> as its first child and reference it with aria-labelledby.',
      'For decorative SVGs, use aria-hidden="true" and drop the role so they are skipped.',
    ],
    effort: "minutes",
    fixHtml: addAriaLabel("Describe what the graphic shows", ["svg"]),
  },

  "object-alt": {
    title: "Embedded objects have no description",
    plainEnglish:
      "Some <object> elements (embedded PDFs, media players, old-style widgets) have no text alternative. Screen readers announce an object with no name and no explanation of what's inside.",
    whyItMatters:
      "Screen reader users can't tell whether the object holds a catalog, a video, or a form, and if the browser can't render it they see nothing at all. A short text alternative fixes both problems.",
    fixSteps: [
      "Add aria-label describing the content, or put fallback text inside the <object> element, for example a link to download the PDF.",
      "Consider replacing the object with a direct link or a native <video> element.",
    ],
    effort: "minutes",
    fixHtml: addAriaLabel("Describe what this embedded content shows", ["object"]),
  },

  "area-alt": {
    title: "Image map areas have no description",
    plainEnglish:
      "Your site uses an image map (a picture with clickable regions) and some of those <area> elements have no alt text. Each region is a link, and without alt text the link has no name.",
    whyItMatters:
      `Screen reader users hear "link" for each region with no idea where it goes, so a clickable floor plan or product diagram becomes unusable. Missing link and image descriptions are ${COMMON_COMPLAINT}.`,
    fixSteps: [
      'Add alt text to every <area> that says where the link goes, for example alt="Women\'s collection".',
      "If the image map is decorative or outdated, replace it with regular links.",
    ],
    effort: "minutes",
    fixHtml: addAlt("Describe where this area links", ["area"]),
  },

  "form-field-multiple-labels": {
    title: "Form fields have more than one label",
    plainEnglish:
      "Some form fields are attached to two or more labels, usually because a visible label and a hidden one both point at the same field. Different screen readers read different labels, so visitors hear inconsistent names.",
    whyItMatters:
      'A screen reader user may hear the wrong or a confusing name for a field ("Email Email address"), which slows down forms and can cause mistakes in checkout.',
    fixSteps: [
      "Keep one <label for> per field; turn any extra text into an aria-describedby hint instead.",
      "Check for duplicate ids that accidentally match more than one label.",
    ],
    effort: "minutes",
  },

  "label-title-only": {
    title: "Form fields are labeled only by a tooltip",
    plainEnglish:
      "Some form fields have no visible label and rely only on a title attribute, the little tooltip that appears on hover. Tooltips don't show on touch screens and aren't reliably read by screen readers.",
    whyItMatters:
      "Mobile users never see the tooltip, so they don't know what to type, and screen reader users may hear nothing at all. Anyone with a memory or attention difficulty needs the label to stay visible while they fill in the field.",
    fixSteps: [
      "Add a visible <label for> element before the field.",
      "Keep the title only as an extra hint, not as the sole name.",
    ],
    effort: "minutes",
    fixHtml: (html) => wrapWithLabel(html, "Field name"),
  },

  "td-headers-attr": {
    title: "Table cells point to missing headers",
    plainEnglish:
      "Some data table cells use a headers attribute that refers to ids that don't exist in the same table. The link between the cell and its column or row header is broken.",
    whyItMatters:
      "Screen reader users read tables cell by cell and rely on the header to know what a number means; a broken reference leaves them with a number and no context, which matters in price lists and size charts.",
    fixSteps: [
      'Make each headers value match the id of a <th> in the same table, or remove the attribute and use <th scope="col"> and scope="row" instead.',
    ],
    effort: "minutes",
  },

  "th-has-data-cells": {
    title: "Table headers have no data cells",
    plainEnglish:
      "Some table header cells (<th>) don't have any data cells that they describe, often because the table is used for layout or the header is in the wrong row.",
    whyItMatters:
      "Screen reader users hear a header that applies to nothing, or data cells with no header, and can't make sense of the table. Size charts and comparison tables are where this shows up most.",
    fixSteps: [
      'Make sure every <th> heads at least one row or column of data, and every data cell has a header; use scope="col" or scope="row" to be explicit.',
      "If the table is only used for layout, replace it with CSS layout or remove the <th> elements.",
    ],
    effort: "hours",
  },

  "focus-order-semantics": {
    title: "Elements in the tab order have no role",
    plainEnglish:
      "Some elements can receive keyboard focus (they have a tabindex) but aren't buttons, links or other controls, so a screen reader can't say what they are or what pressing Enter will do. Clickable <div> and <span> elements are the usual cause.",
    whyItMatters:
      "Keyboard and screen reader users land on something unnamed and have to guess what it does; often it doesn't respond to Enter or Space at all, so they can't open the menu or card behind it.",
    fixSteps: [
      "Replace clickable <div> or <span> elements with a real <button> or <a href>, which come with the right role and keyboard behavior for free.",
      'If you can\'t change the element, add role="button", an accessible name, and keyboard handlers for Enter and Space.',
    ],
    effort: "hours",
  },
};

/** Returns the dictionary entry for a rule, or a generic entry built from axe's help text. */
export function getRule(id: string, fallback: { help: string; helpUrl: string }): RuleEntry {
  const known = RULES[id];
  if (known) return known;
  const help = fallback.help.trim() || id;
  return {
    title: help,
    plainEnglish: help,
    whyItMatters:
      "This check failed on your site. People who rely on assistive technology may not be able to use the affected part of the page.",
    fixSteps: [`Read the rule details: ${fallback.helpUrl}`],
    effort: "hours",
  };
}

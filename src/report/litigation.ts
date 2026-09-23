// Litigation weight and category table used by the ranking engine (spec section 8).
// The weight reflects how often a category of defect shows up in ADA website
// complaints; it is a prioritisation signal, not a legal assessment.

import type { Impact } from "../types.js";

export type Category =
  | "images"
  | "contrast"
  | "forms"
  | "links_buttons"
  | "keyboard"
  | "structure"
  | "language"
  | "media"
  | "aria"
  | "mobile"
  | "other";

export const CATEGORIES: readonly Category[] = [
  "images",
  "contrast",
  "forms",
  "links_buttons",
  "keyboard",
  "structure",
  "language",
  "media",
  "aria",
  "mobile",
  "other",
];

/** Human labels for categories, shared by the mock narrative and the report. */
export const CATEGORY_LABELS: Record<Category, string> = {
  images: "Images",
  contrast: "Color contrast",
  forms: "Forms",
  links_buttons: "Links and buttons",
  keyboard: "Keyboard access",
  structure: "Page structure",
  language: "Language",
  media: "Audio and video",
  aria: "Custom controls",
  mobile: "Mobile use",
  other: "Other checks",
};

export const IMPACT_WEIGHTS: Record<Impact, number> = {
  critical: 4,
  serious: 3,
  moderate: 2,
  minor: 1,
};

export const DEFAULT_LITIGATION_WEIGHT = 1;

export interface LitigationEntry {
  weight: number;
  category: Category;
}

/** axe rule id -> litigation weight and category. Unknown rules get weight 1 and a heuristic category. */
export const LITIGATION: Record<string, LitigationEntry> = {
  "image-alt": { weight: 3, category: "images" },
  "color-contrast": { weight: 3, category: "contrast" },
  label: { weight: 3, category: "forms" },
  "button-name": { weight: 3, category: "links_buttons" },
  "link-name": { weight: 3, category: "links_buttons" },
  "select-name": { weight: 3, category: "forms" },
  "input-image-alt": { weight: 3, category: "images" },
  "html-has-lang": { weight: 2, category: "language" },
  "document-title": { weight: 2, category: "structure" },
  "frame-title": { weight: 2, category: "structure" },
  "heading-order": { weight: 1, category: "structure" },
  "page-has-heading-one": { weight: 1, category: "structure" },
  list: { weight: 1, category: "structure" },
  listitem: { weight: 1, category: "structure" },
  "aria-required-attr": { weight: 2, category: "aria" },
  "aria-valid-attr-value": { weight: 2, category: "aria" },
  "aria-roles": { weight: 2, category: "aria" },
  "aria-hidden-focus": { weight: 2, category: "keyboard" },
  "focus-order-semantics": { weight: 2, category: "keyboard" },
  "scrollable-region-focusable": { weight: 2, category: "keyboard" },
  "meta-viewport": { weight: 3, category: "mobile" },
  "autocomplete-valid": { weight: 1, category: "forms" },
  "duplicate-id-aria": { weight: 1, category: "aria" },
  tabindex: { weight: 2, category: "keyboard" },
  "video-caption": { weight: 3, category: "media" },
  "audio-caption": { weight: 3, category: "media" },
  "form-field-multiple-labels": { weight: 1, category: "forms" },
  "label-title-only": { weight: 1, category: "forms" },
  "nested-interactive": { weight: 2, category: "keyboard" },
  "target-size": { weight: 2, category: "mobile" },
  "link-in-text-block": { weight: 2, category: "links_buttons" },
  "empty-heading": { weight: 1, category: "structure" },
  "td-headers-attr": { weight: 1, category: "structure" },
  "th-has-data-cells": { weight: 1, category: "structure" },
  "role-img-alt": { weight: 3, category: "images" },
  "svg-img-alt": { weight: 3, category: "images" },
  "object-alt": { weight: 2, category: "images" },
  "area-alt": { weight: 2, category: "images" },
};

/** Litigation weight for a rule id (1 when the rule is not in the table). */
export function litigationWeight(ruleId: string): number {
  return LITIGATION[ruleId]?.weight ?? DEFAULT_LITIGATION_WEIGHT;
}

/**
 * Category for a rule id. Rules outside the table are classified by their
 * id shape (aria-*, *-alt, *label*, *-name, ...) and otherwise land in "other".
 */
export function categoryFor(ruleId: string): Category {
  const known = LITIGATION[ruleId];
  if (known) return known.category;
  const id = ruleId.toLowerCase();
  if (id.startsWith("aria-") || id.includes("role")) return "aria";
  if (id.endsWith("-alt") || id.includes("image") || id.includes("img")) return "images";
  if (id.includes("contrast")) return "contrast";
  if (id.includes("label") || id.includes("autocomplete") || id.includes("form")) return "forms";
  if (id.includes("link") || id.includes("button")) return "links_buttons";
  if (id.includes("focus") || id.includes("tabindex") || id.includes("keyboard") || id.includes("accesskey")) {
    return "keyboard";
  }
  if (id.includes("heading") || id.includes("list") || id.includes("landmark") || id.includes("table") || id.includes("td-") || id.includes("th-")) {
    return "structure";
  }
  if (id.includes("lang")) return "language";
  if (id.includes("video") || id.includes("audio") || id.includes("caption")) return "media";
  if (id.includes("viewport") || id.includes("target-size") || id.includes("orientation")) return "mobile";
  return "other";
}

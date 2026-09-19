# Translation scope assessment — Arabic & French (audit urgent #5)

Sampled 2026-09-19 against the new EN hero/fee copy. The auditor's read is
correct on both languages, with different severity.

## Arabic — substantial rework needed

1. **"الـ blockpage"** — the Arabic definite article الـ glued onto the English
   word "blockpage" (`landing.brandSub`, `landing.brandBuildCta`). Either
   transliterate fully or keep the English term bare; the hybrid reads as
   machine output.
2. **"إكرامية" for "tip"** — formal/wrong register. The everyday word for a
   gratuity/tip is "بقشيش".
3. **Mixed-direction strings** — `brand.eyebrow` starts with Latin "blockpages"
   then continues in Arabic. Renders awkwardly even with RTL layout.
4. **Stale after today's EN rewrites** — `brandH1a`, `brandH1b`, `brandSub`,
   `brand.eyebrow`, `splitExplain` all changed in EN and are now out of sync.

RTL rendering itself is fine (`dir="rtl"` is set for `ar` in LanguageContext).

## French — targeted fixes

1. **`nav.townHall` = "La Place"** — loses the civic-assembly meaning of
   "Town Hall" (une place = a public square). Needs a native-speaker call:
   keep "Town Hall" as a proper name, or pick a term that carries the
   meeting-place meaning.
2. **`brandH1b` "de tout"** — stale; EN is now "of every tip" → "de chaque
   pourboire".
3. **Same 5 stale keys** as Arabic after the EN rewrites.

## Structural note

14 supported languages. Every EN copy edit creates translation debt × 13.
Shipping EN-first is pragmatic, but copy should be frozen after the urgent
batch and then given one proper translation sweep — native/professional
review for Arabic at minimum. Do not machine-translate blindly into the
dictionaries; that is how "الـ blockpage" happened.

## Recommended sequencing

1. Finish urgent batch (EN copy settles).
2. Phase 2 translation tasks: retranslate the 5 changed keys + fix the
   flagged ar/fr issues above, with human review before merge.

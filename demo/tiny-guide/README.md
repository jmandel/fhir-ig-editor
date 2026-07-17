# Tiny authoring guide

This is the editor's purpose-built first-run project. It stays small enough to
read in a couple of minutes while demonstrating a real FSH-to-publication flow:

```text
input/fsh/00-EditorUser.fsh
  -> StructureDefinition/editor-user
  -> StructureDefinition-editor-user.html
```

The project deliberately uses `hl7.fhir.template#1.0.0`, not the Cycle external
builder. Cycle remains available as the larger external-builder example.

`04-EditorStages.fsh` and the two `sql-*.md` pages are the SQL demonstration.
They define a three-concept CodeSystem, query the compiled Publisher resource
snapshot, and show two SQL presentation paths: a direct generated table and
`sqlToData` rows shaped by ordinary Liquid. Editing a concept changes both
pages without duplicating the code list in Markdown.

Keep `00-EditorUser.fsh` first and limited to one emitted resource: the editor
can then select that exact declaration automatically and connect Source,
Definition, and Published page without guessing. The suggested cardinality
change must remain valid for `curious-builder` so a newcomer's first edit
demonstrates the normal build loop rather than a validation failure.

The checked-in source is authoritative. `scripts/export-ig-manifest.mjs` bakes
it into the gitignored `app/public/data/tiny/manifest.json` used by the browser.

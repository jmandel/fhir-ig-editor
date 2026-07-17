# The guide that describes its editor

This tiny implementation guide describes someone experimenting with the
**FHIR IG Editor**. It was compiled from FHIR Shorthand and published with the
standard HL7 FHIR IG template, entirely in your browser.

## Follow one rule all the way through

1. In **Author**, open `00-EditorUser.fsh` and change the highlighted
   `name.given` cardinality from `1..*` to `2..*`.
2. Open **Explore** to see that rule in the compiled
   [IG Editor User StructureDefinition](StructureDefinition-editor-user.html).
3. Open **Preview** to see the same constraint on its published profile page.

The [Curious Builder example](Patient-curious-builder.html) already has two
given names, so that edit keeps the example conformant. Try changing the short
description too: prose-only edits should flow to the same definition and page.

## What this small project demonstrates

- a constrained Patient profile with cardinalities, must-support elements,
  a fixed identifier system, a required terminology binding, and an invariant;
- a custom extension referenced by the profile;
- a conformant example instance;
- a small [CapabilityStatement](CapabilityStatement-demo-capabilities.html)
  declaring how a server can read and find conformant patients;
- a guide-owned [CodeSystem](CodeSystem-editor-stage.html), queried live on a
  [generated SQL table](sql-table.html) and a
  [SQL + Liquid narrative](sql-liquid.html); and
- authored Markdown assembled with generated artifact pages by the standard
  HL7 FHIR IG Publisher template.

The subject of this guide is intentionally the person using the tool. The
`ExperimentNote` extension even records what happened: *I changed a FSH rule
and followed it into the published guide.*

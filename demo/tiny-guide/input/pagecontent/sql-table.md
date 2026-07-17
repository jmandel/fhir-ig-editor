# A guide that queries itself

This table is generated from the compiled
[FHIR IG Editor Stages CodeSystem](CodeSystem-editor-stage.html), not copied
into this page.

<div id="editor-stages-sql-table">
{% sql SELECT c.Code AS Code, c.Display AS Display, c.Definition AS Definition FROM Resources r JOIN Concepts c ON c.ResourceKey = r.Key WHERE r.Url = 'https://example.org/fhir-ig-editor-demo/CodeSystem/editor-stage' ORDER BY c.Code %}
</div>

Add or change a concept in `04-EditorStages.fsh` and this table changes with it.

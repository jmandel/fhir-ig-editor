# SQL data shaped with Liquid

The `sqlToData` directive queries the compiled guide, then ordinary Liquid
turns its rows into guide-specific prose.

{% sqlToData editor_stages SELECT c.Code AS code, c.Display AS display, c.Definition AS definition FROM Resources r JOIN Concepts c ON c.ResourceKey = r.Key WHERE r.Url = 'https://example.org/fhir-ig-editor-demo/CodeSystem/editor-stage' ORDER BY c.Code %}

The query found **{{ editor_stages | size }} editor views**:

<ol id="editor-stages-from-sql">
{% for stage in editor_stages %}
<li><strong>{{ stage.display }}</strong> (<code>{{ stage.code }}</code>) — {{ stage.definition }}</li>
{% endfor %}
</ol>

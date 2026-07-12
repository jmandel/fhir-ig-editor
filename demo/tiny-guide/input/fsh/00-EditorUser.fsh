Invariant: has-readable-name
Description: "An editor user has at least one name that another human can read."
Expression: "name.text.exists() or name.family.exists() or name.given.exists()"
Severity: #error

Profile: EditorUser
Parent: Patient
Id: editor-user
Title: "IG Editor User"
Description: "A tiny profile of the curious person editing this guide—possibly you."

* obeys has-readable-name
* extension contains ExperimentNote named experimentNote 0..1 MS
* identifier 1..* MS
* identifier.system 1..1
* identifier.system = "https://example.org/fhir-ig-editor-demo/user" (exactly)
* identifier.value 1..1
* name 1..* MS
// Try changing 1..* to 2..* below. The example already has two given names,
// so the guide stays valid while Definition and Preview show your new rule.
* name.given 1..* MS
* name.given ^short = "Name used while exploring the editor"
* communication 1..* MS
* communication.language from http://hl7.org/fhir/ValueSet/languages (required)

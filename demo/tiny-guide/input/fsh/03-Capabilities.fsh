Instance: demo-capabilities
InstanceOf: CapabilityStatement
Usage: #definition
Title: "Tiny Demo Capabilities"
Description: "The minimal server behavior needed to find an IG Editor User."

* status = #active
* date = "2026-07-11"
* kind = #requirements
* fhirVersion = #4.0.1
* format = #json
* rest.mode = #server
* rest.resource.type = #Patient
* rest.resource.profile = Canonical(EditorUser)
* rest.resource.interaction[0].code = #read
* rest.resource.interaction[1].code = #search-type
* rest.resource.searchParam.name = "identifier"
* rest.resource.searchParam.type = #token
* rest.resource.searchParam.definition = "http://hl7.org/fhir/SearchParameter/Patient-identifier"

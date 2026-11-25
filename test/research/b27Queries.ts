/** Schema-validated candidates only; not executed by production or by the live MCP reads. */
export const itemEvidenceQuery = `query B27ItemEvidence($where: ItemQueryInput!, $after: String, $fallback: Boolean!) {
  item(where: $where) {
    itemId path version language { name } isFallback hasPresentation
    fields(first: 100, after: $after, ownFields: false, withLanguageFallback: $fallback) {
      nodes { fieldId name value containsFallbackValue containsInheritedValue containsStandardValue
        templateField { templateFieldId name type typeKey versioning source }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
export const fieldSourceQuery = `query B27FieldSource($where: ItemQueryInput!, $field: String!, $after: String) {
  item(where: $where) {
    itemId version language { name }
    field(name: $field) {
      fieldId value templateField { templateFieldId source dataSource {
        value
        items(first: 100, after: $after) {
          nodes { itemId name path language { name } version }
          pageInfo { hasNextPage endCursor }
        }
        resolvedSources { sourceIndex source }
      } }
    }
  }
}`;
export const siteContextQuery = `query B27SiteContext($site: String!) {
  site(siteName: $site) { name language device defaultDevice contentLanguage { name } rootItem { itemId path } startItem { itemId path } }
}`;
/** Separate CM Preview endpoint/schema, not Authoring or published Delivery. Not live verified. */
export const previewLayoutQuery = `query B27PreviewLayout($site: String!, $language: String!, $route: String!) {
  layout(site: $site, language: $language, routePath: $route) { item { rendered } }
}`;

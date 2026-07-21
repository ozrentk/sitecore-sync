import gql from "graphql-tag";

export const testConnectionQuery = gql`
  query XmCloudSyncTestConnection {
    sites {
      name
      rootPath
      rootItem {
        itemId
      }
    }
  }
`;

export const treeLevelQuery = gql`
  query XmCloudSyncTreeLevel(
    $where: ItemQueryInput!
    $pageSize: PaginationAmount!
    $after: String
  ) {
    item(where: $where) {
      itemId
      name
      displayName
      path
      hasChildren
      children(first: $pageSize, after: $after) {
        nodes {
          itemId
          name
          displayName
          path
          hasChildren
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const languagesQuery = gql`
  query XmCloudSyncLanguages(
    $databaseName: String!
    $pageSize: PaginationAmount!
    $after: String
  ) {
    languages(databaseName: $databaseName, first: $pageSize, after: $after) {
      nodes {
        name
        displayName
        englishName
        nativeName
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const itemDetailsQuery = gql`
  query XmCloudSyncItemDetails(
    $where: ItemQueryInput!
    $pageSize: PaginationAmount!
    $after: String
  ) {
    item(where: $where) {
      itemId
      path
      version
      language {
        name
      }
      template {
        templateId
        name
      }
      versions(allLanguages: true) {
        language {
          name
        }
        version
      }
      fields(
        first: $pageSize
        after: $after
        ownFields: false
        # TODO: Decide whether field comparison should resolve language fallback.
        # See the fallback investigation in PRODUCT_SPEC.md.
        withLanguageFallback: false
      ) {
        nodes {
          fieldId
          name
          label
          value
          containsFallbackValue
          containsInheritedValue
          containsStandardValue
          templateField {
            templateFieldId
            name
            type
            typeKey
            versioning
            sortOrder
            section {
              itemTemplateSectionId
              name
              sortOrder
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const nonStandardFieldIdsQuery = gql`
  query XmCloudSyncNonStandardFieldIds(
    $where: ItemQueryInput!
    $pageSize: PaginationAmount!
    $after: String
  ) {
    item(where: $where) {
      fields(
        first: $pageSize
        after: $after
        ownFields: false
        excludeStandardFields: true
        # TODO: Keep this aligned with XmCloudSyncItemDetails while fallback is investigated.
        withLanguageFallback: false
      ) {
        nodes {
          fieldId
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const updateFieldValueMutation = gql`
  mutation XmCloudSyncUpdateFieldValue($input: UpdateItemInput!) {
    updateItem(input: $input) {
      item {
        itemId
        path
        version
        language {
          name
        }
      }
    }
  }
`;

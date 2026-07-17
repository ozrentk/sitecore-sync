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

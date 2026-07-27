import gql from "graphql-tag";

export const publishItemsMutation = gql`
  mutation XmCloudSyncPublishItems($input: PublishItemInput!) {
    publishItem(input: $input) {
      operationId
    }
  }
`;

export const publishingStatusQuery = gql`
  query XmCloudSyncPublishingStatus($operationId: String!) {
    publishingStatus(publishingOperationId: $operationId) {
      state
      isDone
      isFailed
      processed
      languages {
        name
      }
      targetDatabase {
        name
      }
    }
  }
`;

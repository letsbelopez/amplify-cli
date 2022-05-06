/* eslint-disable spellcheck/spell-checker */
import { stateManager } from 'amplify-cli-core';
import { printer } from 'amplify-prompts';
import { ResourceConstants } from 'graphql-transformer-common';
import _ from 'lodash';
import { getGraphQLTransformerOpenSearchProductionDocLink } from '../doc-links';
import { getTransformerVersion } from '../graphql-transformer-factory';

/**
 * Check for any searchable models, and if the customer has configured their instance type in a way we don't recommend
 * for a production workfload, throw a warning through the CLI.
 */
export const searchablePushChecks = async (context, map, apiName): Promise<void> => {
  const searchableModelTypes = Object.keys(map).filter(type => map[type].includes('searchable') && map[type].includes('model'));
  if (searchableModelTypes.length) {
    const currEnv = context.amplify.getEnvInfo().envName;
    const teamProviderInfo = stateManager.getTeamProviderInfo();
    const instanceType = _.get(
      teamProviderInfo,
      [currEnv, 'categories', 'api', apiName, ResourceConstants.PARAMETERS.ElasticsearchInstanceType],
      't2.small.elasticsearch',
    );
    if (instanceType === 't2.small.elasticsearch' || instanceType === 't3.small.elasticsearch') {
      const transformerVersion = await getTransformerVersion(context);
      const docLink = getGraphQLTransformerOpenSearchProductionDocLink(transformerVersion);
      printer.warn(
        `Your instance type for OpenSearch is ${instanceType}, you may experience performance issues or data loss. Consider reconfiguring with the instructions here ${docLink}`,
      );
    }
  }
};

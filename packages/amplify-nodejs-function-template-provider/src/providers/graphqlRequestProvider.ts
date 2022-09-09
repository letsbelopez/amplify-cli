import { FunctionTemplateParameters } from 'amplify-function-plugin-interface';
import path from 'path';
import fs from 'fs-extra';
import {
  stateManager, AmplifySupportedService, exitOnNextTick,
} from 'amplify-cli-core';
import { getDstMap } from '../utils/destFileMapper';
import { templateRoot } from '../utils/constants';
import * as gql from 'graphql-transformer-core';

const pathToTemplateFilesIAM = path.join(templateRoot, 'lambda/appsync-request');

/**
 * Graphql request to an AppSync API using Node runtime Lambda function
 */
export async function graphqlRequest(context: any): Promise<FunctionTemplateParameters> {
  const { allResources } = await context.amplify.getResourceStatus();
  const apiResource = allResources.filter((resource: { service: string }) => resource.service === AmplifySupportedService.APPSYNC);
  let apiResourceName: string;
  
  if (apiResource.length > 0) {
    const resource = apiResource[0];
    apiResourceName = resource.resourceName;
  } else {
    throw new Error(`${AmplifySupportedService.APPSYNC} API does not exist. To add an api, use "amplify add api".`);
  }

  const authConfigs = allResources[1].output.authConfig;

  const additionalAuth = authConfigs.additionalAuthenticationProviders.filter((obj: { authenticationType: string; }) => obj.authenticationType === 'AWS_IAM');

  if (authConfigs.defaultAuthentication.authenticationType !== 'AWS_IAM' && Object.keys(additionalAuth).length === 0) {
    context.print.error(`IAM Auth not enabled for ${AmplifySupportedService.APPSYNC} API. To update an api, use "amplify update api".`);
    exitOnNextTick(0);
  }

  const files = fs.readdirSync(pathToTemplateFilesIAM);
  return Promise.resolve({
    functionTemplate: {
      sourceRoot: pathToTemplateFilesIAM,
      sourceFiles: files,
      defaultEditorFile: path.join('src', 'index.js'),
      destMap: getDstMap(files),
    },
  });
}

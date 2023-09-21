import { AppSyncAuthConfiguration } from '@aws-amplify/graphql-transformer-interfaces';
import { ExecuteTransformConfig, executeTransform } from '@aws-amplify/graphql-transformer';
import { DeploymentResources } from './deployment-resources';
import { TransformManager } from './transform-manager';

export const defaultTransformParams: Pick<ExecuteTransformConfig, 'transformersFactoryArgs' | 'transformParameters'> = {
  transformersFactoryArgs: {},
  transformParameters: {
    shouldDeepMergeDirectiveConfigDefaults: true,
    // eslint-disable-next-line spellcheck/spell-checker
    disableResolverDeduping: false,
    sandboxModeEnabled: false,
    useSubUsernameForDefaultIdentityClaim: true,
    populateOwnerFieldForStaticGroupAuth: true,
    suppressApiKeyGeneration: false,
    secondaryKeyAsGSI: true,
    enableAutoIndexQueryNames: true,
    respectPrimaryKeyAttributesOnConnectionField: true,
    enableSearchNodeToNodeEncryption: false,
  },
};

const getAuthenticationTypesForAuthConfig = (authConfig?: AppSyncAuthConfiguration): (string | undefined)[] =>
  [authConfig?.defaultAuthentication, ...(authConfig?.additionalAuthenticationProviders ?? [])].map(
    (authConfigEntry) => authConfigEntry?.authenticationType,
  );

const hasIamAuth = (authConfig?: AppSyncAuthConfiguration): boolean =>
  getAuthenticationTypesForAuthConfig(authConfig).some((authType) => authType === 'AWS_IAM');

const hasUserPoolAuth = (authConfig?: AppSyncAuthConfiguration): boolean =>
  getAuthenticationTypesForAuthConfig(authConfig).some((authType) => authType === 'AMAZON_COGNITO_USER_POOLS');

export const transformAndSynth = (
  options: Omit<ExecuteTransformConfig, 'scope' | 'nestedStackProvider' | 'assetProvider' | 'synthParameters'>,
): DeploymentResources => {
  const transformManager = new TransformManager();
  executeTransform({
    ...options,
    scope: transformManager.rootStack,
    nestedStackProvider: transformManager.getNestedStackProvider(),
    assetProvider: transformManager.getAssetProvider(),
    synthParameters: transformManager.getSynthParameters(hasIamAuth(options.authConfig), hasUserPoolAuth(options.authConfig)),
  });
  return transformManager.generateDeploymentResources();
};

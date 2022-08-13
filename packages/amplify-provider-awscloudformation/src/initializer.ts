/* eslint-disable func-style */
/* eslint-disable prefer-arrow/prefer-arrow-functions */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { $TSContext, JSONUtilities, PathConstants, pathManager, stateManager, Template } from 'amplify-cli-core';
import _ from 'lodash';
import { transformRootStack } from './override-manager';
import { rootStackFileName } from './push-resources';
import { getDefaultTemplateDescription } from './template-description-utils';
import * as vm from 'vm2';
import { printer, formatter, AmplifySpinner } from 'amplify-prompts';

const moment = require('moment');
const path = require('path');
const glob = require('glob');
const archiver = require('./utils/archiver');
const fs = require('fs-extra');
const sequential = require('promise-sequential');
const Cloudformation = require('./aws-utils/aws-cfn');
const { S3 } = require('./aws-utils/aws-s3');
const constants = require('./constants');
const configurationManager = require('./configuration-manager');
const amplifyServiceManager = require('./amplify-service-manager');
const amplifyServiceMigrate = require('./amplify-service-migrate');
const { fileLogger } = require('./utils/aws-logger');
const { prePushCfnTemplateModifier } = require('./pre-push-cfn-processor/pre-push-cfn-modifier');
const logger = fileLogger('attach-backend');
const { configurePermissionsBoundaryForInit } = require('./permissions-boundary/permissions-boundary');
import { v4 as uuid } from 'uuid';

type ParamType = {
  StackName: string,
  Capabilities: string[],
  TemplateBody: string,
  Parameters: {ParameterKey: string, ParameterValue: string}[],
  Tags: string[],
};

export async function run(context) {
  await configurationManager.init(context);
  if (!context.exeInfo || context.exeInfo.isNewEnv) {
    context.exeInfo = context.exeInfo || {};
    const { projectName } = context.exeInfo.projectConfig;
    const initTemplateFilePath = path.join(__dirname, '..', 'resources', 'rootStackTemplate.json');
    const timeStamp = process.env.CIRCLECI ? uuid().substring(0, 5) : `${moment().format('Hmmss')}`;
    const { envName = '' } = context.exeInfo.localEnvInfo;
    let stackName = normalizeStackName(`amplify-${projectName}-${envName}-${timeStamp}`);
    const awsConfigInfo = await configurationManager.getAwsConfig(context);

    await configurePermissionsBoundaryForInit(context);

    const amplifyServiceParams = {
      context,
      awsConfigInfo,
      projectName,
      envName,
      stackName,
    };
    const { amplifyAppId, verifiedStackName, deploymentBucketName } = await amplifyServiceManager.init(amplifyServiceParams);

    // start root stack builder and deploy

    // moved cfn build to next its builder
    stackName = verifiedStackName;
    const Tags = context.amplify.getTags(context);

    const authRoleName = `${stackName}-authRole`;
    const unauthRoleName = `${stackName}-unauthRole`;

    const configuration = {
      authRole: {
        roleName: authRoleName,
      },
      unauthRole: {
        roleName: unauthRoleName,
      },
    };

    try {
      const backendDir = pathManager.getBackendDirPath();
      const overrideFilePath = path.join(backendDir, 'awscloudformation', 'build', 'override.js');
      const overrideCode: string = await fs.readFile(overrideFilePath, 'utf-8');
      if (overrideCode) {
        const sandboxNode = new vm.NodeVM({
          console: 'inherit',
          timeout: 5000,
          sandbox: {},
          require: {
            context: 'sandbox',
            builtin: ['path'],
            external: true,
          },
        });
        sandboxNode.run(overrideCode).override(configuration);
      }
    } catch (e) {
      printer.debug(`Unable to apply auth role overrides: ${e.message}`);
    }

    const rootStack = JSONUtilities.readJson<Template>(initTemplateFilePath);

    await prePushCfnTemplateModifier(rootStack);

    rootStack.Description = getDefaultTemplateDescription(context, 'root');

    // deploy steps
    const params = {
      StackName: stackName,
      Capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
      TemplateBody: JSON.stringify(rootStack),
      Parameters: [
        {
          ParameterKey: 'DeploymentBucketName',
          ParameterValue: deploymentBucketName,
        },
        {
          ParameterKey: 'AuthRoleName',
          ParameterValue: configuration.authRole.roleName,
        },
        {
          ParameterKey: 'UnauthRoleName',
          ParameterValue: configuration.unauthRole.roleName,
        },
      ],
      Tags,
    };

    const eventMap = createInitEventMap(params, envName, projectName);
    const cfnItem = await new Cloudformation(context, 'init', awsConfigInfo, eventMap);
    const stackDescriptionData = await cfnItem.createResourceStack(params);

    processStackCreationData(context, amplifyAppId, stackDescriptionData);
    cloneCLIJSONForNewEnvironment(context);

    return context;
  } else if(
    // This part of the code is invoked by the `amplify init --appId xxx` command
    // on projects that are already fully setup by `amplify init` with the Amplify CLI version prior to 4.0.0.
    // It expects all the artifacts in the `amplify/.config` directory, the amplify-meta.json file in both
    // the `#current-cloud-backend` and the `backend` directories, and the team-provider-info file to exist.
    // It allows the local project's env to be added to an existing Amplify Console project, as specified
    // by the appId, without unneccessarily creating another Amplify Console project by the post push migration.
    !context.exeInfo.isNewProject &&
    context.exeInfo.inputParams &&
    context.exeInfo.inputParams.amplify &&
    context.exeInfo.inputParams.amplify.appId
  ) {
    await amplifyServiceMigrate.run(context);
  } else {
    setCloudFormationOutputInContext(context, {});
  }
}

type EventMap = {
  rootStackName: string,
  rootResources: {key: string}[],
  categories: string[],
  envName: string,
  projectName: string
}

function createInitEventMap(params: ParamType, envName: string, projectName: string) : EventMap {
  return {
    rootStackName: params.StackName,
    rootResources: params.Parameters.map(item => {
      const key = item.ParameterKey;
      return {
        key: key.endsWith('Name') ? key.replace(/.{0,4}$/, '') : key,
      };
    }),
    categories: [],
    envName,
    projectName,
  };
}

function processStackCreationData(context, amplifyAppId, stackDescriptiondata) {
  const metadata = {};
  if (stackDescriptiondata.Stacks && stackDescriptiondata.Stacks.length) {
    const { Outputs } = stackDescriptiondata.Stacks[0];
    Outputs.forEach(element => {
      metadata[element.OutputKey] = element.OutputValue;
    });
    if (amplifyAppId) {
      metadata[constants.AmplifyAppIdLabel] = amplifyAppId;
    }

    setCloudFormationOutputInContext(context, metadata);
  } else {
    throw new Error('No stack data present');
  }
}

function setCloudFormationOutputInContext(context: $TSContext, cfnOutput: object) {
  _.set(context, ['exeInfo', 'amplifyMeta', 'providers', constants.ProviderName], cfnOutput);
  const { envName } = context.exeInfo.localEnvInfo;
  if (envName) {
    const providerInfo = _.get(context, ['exeInfo', 'teamProviderInfo', envName, constants.ProviderName]);
    if (providerInfo) {
      _.merge(providerInfo, cfnOutput);
    } else {
      _.set(context, ['exeInfo', 'teamProviderInfo', envName, constants.ProviderName], cfnOutput);
    }
  }
}

function cloneCLIJSONForNewEnvironment(context) {
  if (context.exeInfo.isNewEnv && !context.exeInfo.isNewProject) {
    const { projectPath } = context.exeInfo.localEnvInfo;
    const { envName } = stateManager.getLocalEnvInfo(undefined, {
      throwIfNotExist: false,
      default: {},
    });

    if (envName) {
      const currentEnvCLIJSONPath = pathManager.getCLIJSONFilePath(projectPath, envName);

      if (fs.existsSync(currentEnvCLIJSONPath)) {
        const newEnvCLIJSONPath = pathManager.getCLIJSONFilePath(projectPath, context.exeInfo.localEnvInfo.envName);

        fs.copyFileSync(currentEnvCLIJSONPath, newEnvCLIJSONPath);
      }
    }
  }
}

export async function onInitSuccessful(context) {
  configurationManager.onInitSuccessful(context);
  if (context.exeInfo.isNewEnv) {
    await storeRootStackTemplate(context);
    context = await storeCurrentCloudBackend(context);
    await storeArtifactsForAmplifyService(context);
  }
  return context;
}

export const storeRootStackTemplate = async (context: $TSContext, template?: Template) => {
  // generate template again as the folder structure was not created when root stack was initiaized
  if (template === undefined) {
    template = await transformRootStack(context);
  }
  // apply Modifiers
  await prePushCfnTemplateModifier(template);
  // RootStack deployed to backend/awscloudformation/build
  const projectRoot = pathManager.findProjectRoot();
  const rootStackBackendBuildDir = pathManager.getRootStackBuildDirPath(projectRoot);
  const rootStackCloudBackendBuildDir = pathManager.getCurrentCloudRootStackDirPath(projectRoot);

  fs.ensureDirSync(rootStackBackendBuildDir);
  const rootStackBackendFilePath = path.join(rootStackBackendBuildDir, rootStackFileName);
  JSONUtilities.writeJson(rootStackBackendFilePath, template);
  // copy the awscloudformation backend to #current-cloud-backend
  fs.copySync(path.join(rootStackBackendBuildDir, '..'), path.join(rootStackCloudBackendBuildDir, '..'));
};

function storeCurrentCloudBackend(context) {
  const zipFilename = '#current-cloud-backend.zip';
  const backendDir = context.amplify.pathManager.getBackendDirPath();
  const tempDir = path.join(backendDir, '.temp');
  const currentCloudBackendDir = context.exeInfo
    ? path.join(context.exeInfo.localEnvInfo.projectPath, PathConstants.AmplifyDirName, PathConstants.CurrentCloudBackendDirName)
    : context.amplify.pathManager.getCurrentCloudBackendDirPath();

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const cliJSONFiles = glob.sync(PathConstants.CLIJSONFileNameGlob, {
    cwd: pathManager.getAmplifyDirPath(),
    absolute: true,
  });

  // handle tag file
  const tagFilePath = pathManager.getTagFilePath();
  const tagCloudFilePath = pathManager.getCurrentTagFilePath();
  if (fs.existsSync(tagFilePath)) {
    fs.copySync(tagFilePath, tagCloudFilePath, { overwrite: true });
  }

  const zipFilePath = path.normalize(path.join(tempDir, zipFilename));
  let log = null;
  const spinner = new AmplifySpinner('Saving deployment state.');

  return archiver
    .run(currentCloudBackendDir, zipFilePath, undefined, cliJSONFiles)
    .then(result => {
      const s3Key = `${result.zipFilename}`;
      spinner.start();
      return S3.getInstance(context).then(s3 => {
        spinner.stop('Deployment bucket fetched.');
        const s3Params = {
          Body: fs.createReadStream(result.zipFilePath),
          Key: s3Key,
        };
        log = logger('storeCurrentCloudBackend.s3.uploadFile', [{ Key: s3Key }]);
        log();
        return s3.uploadFile(s3Params);
      });
    })
    .catch(ex => {
      log(ex);
      spinner.stop('Deployment state save failed.', false);
      throw ex;
    })
    .then(() => {
      fs.removeSync(tempDir);
      return context;
    });
}

function storeArtifactsForAmplifyService(context) {
  return S3.getInstance(context).then(async s3 => {
    const currentCloudBackendDir = context.amplify.pathManager.getCurrentCloudBackendDirPath();
    const amplifyMetaFilePath = path.join(currentCloudBackendDir, 'amplify-meta.json');
    const backendConfigFilePath = path.join(currentCloudBackendDir, 'backend-config.json');
    const fileUploadTasks = [];

    fileUploadTasks.push(() => uploadFile(s3, amplifyMetaFilePath, 'amplify-meta.json'));
    fileUploadTasks.push(() => uploadFile(s3, backendConfigFilePath, 'backend-config.json'));
    await sequential(fileUploadTasks);
  });
}

async function uploadFile(s3, filePath, key) {
  if (fs.existsSync(filePath)) {
    const s3Params = {
      Body: fs.createReadStream(filePath),
      Key: key,
    };
    const log = logger('uploadFile.s3.uploadFile', [{ Key: key }]);
    try {
      log();
      await s3.uploadFile(s3Params);
    } catch (ex) {
      log(ex);
      throw ex;
    }
  }
}

function normalizeStackName(stackName) {
  let result = stackName.toLowerCase().replace(/[^-a-z0-9]/g, '');
  if (/^[^a-zA-Z]/.test(result) || result.length === 0) {
    result = `a${result}`;
  }
  return result;
}

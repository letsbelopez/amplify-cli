import { $TSAny, $TSContext } from "amplify-cli-core";
import { loadLambdaConfig } from '../utils/lambda/load-lambda-config';
import { BuildType, FunctionRuntimeLifecycleManager, BuildRequest } from 'amplify-function-plugin-interface';
import { getInvoker, getBuilder } from 'amplify-category-function';
import { timeConstrainedInvoker } from '../func';
import { printer } from 'amplify-prompts';
import { LambdaTrigger, LambdaTriggerConfig } from "../utils/lambda/find-lambda-triggers";

/**
 * Utility method to invoke the lambda function locally. 
 * Ensures latest function changes are built before invoking it.
 * @param context The CLI context
 * @param trigger Lambda trigger to invoke locally
 * @param data Data to be passed to the local lambda function invocation.
 */
export const invokeTrigger = async (context: $TSContext, trigger: LambdaTrigger, data: $TSAny): Promise<void> => {
  let invoker: $TSAny;

  if (trigger?.name) {
    const functionName = trigger.name;
    const lambdaConfig = await loadLambdaConfig(context, functionName, true);
    if (!lambdaConfig?.handler) {
      throw new Error(`Could not parse handler for ${functionName} from cloudformation file`);
    }
    // Ensuring latest function changes are built
    await getBuilder(context, functionName, BuildType.DEV)();
    invoker = await getInvoker(context, { resourceName: functionName, handler: lambdaConfig.handler, envVars: lambdaConfig.environment });
  }
  else {
    const envVars = trigger?.config?.envVars || {};
    if (!trigger?.config?.runtimePluginId || 
      !trigger?.config?.handler || 
      !trigger?.config?.runtime ||
      !trigger?.config?.directory) {
      throw new Error(`Could not parse lambda config for non-function category trigger`);
    }

    const runtimeManager: FunctionRuntimeLifecycleManager = await context.amplify.loadRuntimePlugin(context, trigger.config.runtimePluginId);

    if (trigger?.config?.reBuild) {
      await buildLambdaTrigger(context, trigger.config);
    }

    invoker = ({ event }) => runtimeManager.invoke({
      handler: trigger.config.handler,
      event: JSON.stringify(event),
      runtime: trigger.config.runtime,
      srcRoot: trigger.config.directory,
      envVars
    });
  }
  
  printer.info('Starting execution...');
  try {
    const result = await timeConstrainedInvoker(invoker({ event: data }), context?.input?.options);
    const stringResult = stringifyResult(result);
    printer.success('Result:');
    printer.info(stringResult);
  } catch (err) {
    printer.error(`Lambda trigger failed with the following error:`);
    printer.info(err);
  } finally {
    printer.info('Finished execution.');
  }
}

const stringifyResult = (result: $TSAny) => {
  return typeof result === 'object' ? JSON.stringify(result, undefined, 2) : typeof result === 'undefined' ? '' : result;
}

export const buildLambdaTrigger = async (context: $TSContext, triggerConfig: Pick<LambdaTriggerConfig, 'runtime' | 'directory' | 'runtimePluginId'>) => {
  const runtimeManager: FunctionRuntimeLifecycleManager = await context.amplify.loadRuntimePlugin(context, triggerConfig?.runtimePluginId);
  const runtimeRequirmentsCheck = await runtimeManager.checkDependencies(triggerConfig?.runtime);
  if (!(runtimeRequirmentsCheck?.hasRequiredDependencies)) {
    const runtimeRequirementsError = 'Required dependencies to build the lambda trigger are missing';
    printer.error(runtimeRequirmentsCheck?.errorMessage || runtimeRequirementsError);
    throw new Error(runtimeRequirementsError);
  }

  // Ensuring latest function changes are built
  const buildRequest: BuildRequest = {
    buildType: BuildType.DEV,
    srcRoot: triggerConfig?.directory,
    runtime: triggerConfig?.runtime
  };
  await runtimeManager.build(buildRequest);
}
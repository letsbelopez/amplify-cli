import { nspawn as spawn, getCLIPath } from '..';

/**
 * invokes cli for diagnose with --send-report flag
 * @param cwd current working directory
 * @returns void
 */
export const diagnoseSendReport = async (cwd: string): Promise<string> => {
  let path = '';
  const callback = (text:string): void => {
    const index = text.lastIndexOf(':');
    path = text.substring(index + 1).trim();
  };
  await spawn(getCLIPath(), ['diagnose', '--send-report'], { cwd, stripColors: true })
    .wait(/Report saved/, callback)
    .wait(/Done/)
    .sendEof()
    .runAsync();
  return path;
};

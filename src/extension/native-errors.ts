// Chrome errors may include local paths. Expose only known diagnostic codes.
import {safeErrorDetails} from '../shared.js';
export function nativeErrorDetails(error:unknown,version:1|2){
  const details=safeErrorDetails(error);
  return details&&version===1?{targetId:details.targetId,blockers:details.blockers}:details;
}
export function nativeErrorData(error:unknown,version:1|2){const details=nativeErrorDetails(error,version);return details?{details}:undefined;}
export function nativeErrorCode(message?:string):string {
  if(message?.includes('Specified native messaging host not found'))return 'native_host_not_registered';
  if(message?.includes('Access to the specified native messaging host is forbidden'))return 'native_host_forbidden';
  if(message?.includes('Failed to start native messaging host'))return 'native_host_start_failed';
  if(message?.includes('Native host has exited'))return 'native_host_exited';
  if(message?.includes('Error when communicating with the native messaging host'))return 'native_host_protocol_error';
  return 'native_host_unavailable';
}

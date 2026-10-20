import { base64ToBin } from "@bitauth/libauth";
import {
  OpReturnData,
  opReturnFromBytes,
  SendRequest,
  TokenSendRequest,
} from "../wallet/model.js";

export function asSendRequestObject(
  requests:
    | SendRequest
    | TokenSendRequest
    | OpReturnData
    | Array<SendRequest | TokenSendRequest | OpReturnData>,
): Array<SendRequest | TokenSendRequest | OpReturnData> {
  if (Array.isArray(requests)) {
    return requests.map(convertToClass);
  }
  return [convertToClass(requests)];
}

function convertToClass(object: SendRequest | TokenSendRequest | OpReturnData) {
  if (object.hasOwnProperty("category")) {
    return new TokenSendRequest(object as TokenSendRequest);
  } else if (object.hasOwnProperty("buffer")) {
    return opReturnFromBytes((object as OpReturnData).buffer);
  }
  // endcoding in REST
  else if (object.hasOwnProperty("dataString")) {
    return OpReturnData.fromString((object as any).dataString);
  } else if (object.hasOwnProperty("dataBuffer")) {
    return opReturnFromBytes(
      Uint8Array.from(base64ToBin((object as any).dataBuffer)),
    );
  } else if (
    object.hasOwnProperty("cashaddr") &&
    object.hasOwnProperty("value") &&
    object.hasOwnProperty("category") === false
  ) {
    return new SendRequest(object as SendRequest);
  }

  throw new Error("Unsupported send object");
}

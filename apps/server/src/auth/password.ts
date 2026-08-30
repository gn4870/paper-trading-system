/**
 * 密码摘要工具。
 *
 * scrypt 是面向密码的慢哈希；每个密码使用独立随机盐。摘要中保存算法版本、
 * 盐和派生密钥，不保存明文密码。比较时使用 timingSafeEqual 降低时序泄漏。
 */
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const DIGEST_PREFIX = "scrypt-v1";
const SALT_BYTES = 16;
const KEY_BYTES = 64;

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const key = (await scrypt(password, salt, KEY_BYTES)) as Buffer;
  return `${DIGEST_PREFIX}:${salt.toString("hex")}:${key.toString("hex")}`;
};

export const verifyPassword = async (
  password: string,
  digest: string
): Promise<boolean> => {
  const [prefix, saltHex, keyHex, extra] = digest.split(":");
  if (
    prefix !== DIGEST_PREFIX ||
    saltHex === undefined ||
    keyHex === undefined ||
    extra !== undefined ||
    saltHex.length !== SALT_BYTES * 2 ||
    keyHex.length !== KEY_BYTES * 2 ||
    !/^[0-9a-f]+$/i.test(saltHex) ||
    !/^[0-9a-f]+$/i.test(keyHex)
  ) {
    return false;
  }

  const expected = Buffer.from(keyHex, "hex");
  const actual = (await scrypt(
    password,
    Buffer.from(saltHex, "hex"),
    KEY_BYTES
  )) as Buffer;
  return timingSafeEqual(actual, expected);
};

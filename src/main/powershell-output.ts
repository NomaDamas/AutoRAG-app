/**
 * Windows PowerShell writes a redirected stdout in the console's OEM code page (949 on Korean Windows) unless told
 * otherwise, while Node decodes a child's stdout as UTF-8: a Korean file-type name or volume label arrived as
 * `���Ŀ��ǽ�…`. Every script whose output the app reads starts with this statement, so the bytes are UTF-8 (no BOM).
 */
export const POWERSHELL_UTF8_OUTPUT = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)";

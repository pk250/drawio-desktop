// Repair truncated IEND chunk in draw.io embedded-PNG exports.
//
// draw.io's CLI emits `-e` PNGs with the 4-byte IEND length field but missing
// the 8 bytes of "IEND" type + CRC. Strict PNG decoders and vision APIs reject
// such files. Idempotent: the endswith(IEND) guard makes this a no-op once
// draw.io fixes the bug upstream.

import fs from 'fs';

const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export function repairPng(path)
{
	let data;

	try
	{
		data = fs.readFileSync(path);
	}
	catch (e)
	{
		throw new Error(`cannot read PNG for repair: ${e.message}`);
	}

	if (data.length >= 12 && data.subarray(data.length - 12).equals(IEND))
	{
		return false;
	}

	let out = data;

	if (data.length >= 4 && data.subarray(data.length - 4).equals(Buffer.alloc(4)))
	{
		out = data.subarray(0, data.length - 4);
	}

	fs.writeFileSync(path, Buffer.concat([out, IEND]));

	return true;
}

export function requireNode(version: string, range: string): void {
	const minimum = /^>=(\d+)\.(\d+)(?:\.(\d+))?(?: <(\d+))?$/.exec(range);
	const actual = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!minimum) throw new Error(`Unsupported Node requirement: ${range}`);
	if (actual && Number(actual[1]) % 2 === 0 && (!minimum[4] || Number(actual[1]) < Number(minimum[4]))) {
		for (let index = 1; index <= 3; index++) {
			const difference = Number(actual[index]) - Number(minimum[index] ?? 0);
			if (difference > 0) return;
			if (difference < 0) break;
			if (index === 3) return;
		}
	}
	const majors: string[] = [];
	for (let major = Number(minimum[1]); major < Number(minimum[4]); major++) {
		if (major % 2 === 0) majors.push(major === Number(minimum[1]) ? `${major} (${minimum[1]}.${minimum[2]}.${minimum[3] ?? 0} or later)` : String(major));
	}
	const supported = majors.length ? majors.join(" or Node ") : `${range} (even major versions only)`;
	throw new Error(`Check requires Node ${supported}; received ${version}`);
}

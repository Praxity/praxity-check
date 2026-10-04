// package.json owns the required range. Accept its minimum-version format explicitly.
export function requireNode(version: string, range: string): void {
	const minimum = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range);
	const actual = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!minimum) throw new Error(`Unsupported Node requirement: ${range}`);
	if (actual) {
		for (let index = 1; index <= 3; index++) {
			const difference = Number(actual[index]) - Number(minimum[index] ?? 0);
			if (difference > 0) return;
			if (difference < 0) break;
			if (index === 3) return;
		}
	}
	throw new Error(`Check requires Node ${range}; received ${version}`);
}

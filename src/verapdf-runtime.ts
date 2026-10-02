// The Java launcher is shared by Windows preparation and PDF validation.
export const veraPdfMainClass = "org.verapdf.apps.GreenfieldCliWrapper";

export function veraPdfJavaArgs(classpath: string, args: string[]): string[] {
	if (!classpath.trim()) throw new Error("veraPDF Java classpath must not be empty");
	return ["-Dfile.encoding=UTF8", "--add-exports=java.base/sun.security.pkcs=ALL-UNNAMED", "-classpath", classpath,
		veraPdfMainClass, ...args];
}

export function javaEnvironment(env: NodeJS.ProcessEnv, platform = process.platform): NodeJS.ProcessEnv {
	const blocked = new Set(["CLASSPATH_PREFIX", "JAVA_OPTS", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"]);
	return Object.fromEntries(Object.entries(env).filter(([key]) => !blocked.has(platform === "win32" ? key.toUpperCase() : key)));
}

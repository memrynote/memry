// The web variants of the template components import CSS for react-native-web
// builds; tsc needs these ambient declarations (Metro handles the real files).
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'

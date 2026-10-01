/** A binding for Flagship apps. */
export type Flagship = {
  type: "flagship";
  appId: string;
};
export function Flagship(appId: string): Flagship {
  if (!appId) {
    throw new Error("Flagship appId must not be empty");
  }
  return {
    type: "flagship",
    appId,
  };
}

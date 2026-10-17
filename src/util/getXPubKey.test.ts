import { binToHex, deriveSeedFromBip39Mnemonic } from "@bitauth/libauth";
import { getAddrsByXpubKey } from "./getAddrsByXpubKey.js";
import { getXPubKey } from "./getXPubKey.js";

const seed = deriveSeedFromBip39Mnemonic(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);

// common derivation paths, a la Electron Cash's install wizard
const vectors: Array<[string, string]> = [
  [
    "m/0",
    "xpub68jrRzQfUmwSaf5Y37Yd5uwfnMRxiR14M3HBonDr91GB7GKEh7R9Mvu2UeCtbASfXZ9FdNo9FwFx6a37HNXUDiXVQFXuadXmevRBa3y7rL8",
  ],
  [
    "m/0'",
    "xpub68jrRzQopSUQm76hJ6TNtiJMJfhj38u1X12xCzExrw388hcN443UVnYpswdUkV7vPJ3KayiCdp3Q5E23s4wvkucohVTh7eSstJdBFyn2DMx",
  ],
  [
    "m/0'/0",
    "xpub6A7PsGUCo9qsn1jhZVB68WKWU9bTt1Wu7fzRqhczRbJ3u3xsF1bJmWBL1MvygTtrfmvNw1adLzmRjQHtDCJDXAHFa4K3wELpGGqEXL4e6d4",
  ],
  [
    "m/0'/0'",
    "xpub6A7PsGUM8pNqwy9AceVuFK6KxY88FhvFMRGP9fjEDKA3P4WpR1zyHH3Lmczj7eorx4RbDC4Qttd8C7HhLA2W9LsxxZzXo1DMCwJFb3zZKZ8",
  ],
  [
    "m/0'/0'/0'",
    "xpub6BiChRN7aqq51RA7RnAmKhqKdGckPncrHWLrj1xoj6ZMfdMJ1dX4Ysh9V3yEhpFCpC3BapjR83xPKY693XXTEU6qgWU3qZs78WBHA15uhYf",
  ],
  [
    "m/44'/0'/0'",
    "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj",
  ],
  [
    "m/44'/0'/0'/0",
    "xpub6ELHKXNimKbxMCytPh7EdC2QXx46T9qLDJWGnTraz1H9kMMFdcduoU69wh9cxP12wDxqAAfbaESWGYt5rREsX1J8iR2TEunvzvddduAPYcY",
  ],
  [
    "m/44'/145'/0'",
    "xpub6ByHsPNSQXTWZ7PLESMY2FufyYWtLXagSUpMQq7Un96SiThZH2iJB1X7pwviH1WtKVeDP6K8d6xxFzzoaFzF3s8BKCZx8oEDdDkNnp4owAZ",
  ],
  [
    "m/44'/145'/0'/0",
    "xpub6F2iaK2JUPcgrZ6RTGH6t8VybLPu1XzfrHsDsaKvK6NfULznU6i6aw6ZoefDW2DpNruSLw73RwQg46qvpqB3eryeJJ2tkFCF4Z6gbr8Pjja",
  ],
  [
    "m/44'/245'/0",
    "xpub6Ch34ms5osevEtkEZX81n8EG4c6vgHWGH1gQXBG2uf2Tihb1eed4H1wozLfZB31mV9JD7mymYTQxcLKFFjZHdM5NGdH2Ud1ksSkfwSFjjCg",
  ],
  [
    "m/44'/245'/0'",
    "xpub6Ch34msE9YBtQV7pZrLyRXHwocrpJtNN4KDG8bbyxyhGmEM5MirtqkiH4h9dvnVJ3MekET3w2Fkvej3fyo8WLz9bRPyDynDf6NXNfuydhv1",
  ],
  [
    "m/44'/245'/0'/0",
    "xpub6FFeETss5Zwkw78NDAibKEaGxigU3bgYzLihcqbQqqTyb6jorR9mgR9AexYydxmiPU8koAf5ndaQPjPWK3sDz1wjBjf2TkLbD982S9PWd9Z",
  ],
];

test.each(vectors)("derives the xpub at %s", (path, xpub) => {
  expect(getXPubKey(seed, path, "mainnet")).toBe(xpub);
});

test("takes the seed as hex", () => {
  const [path, xpub] = vectors[7];
  expect(getXPubKey(binToHex(seed), path, "mainnet")).toBe(xpub);
});

test("encodes a testnet xpub for the testnet network", () => {
  expect(getXPubKey(seed, "m/44'/145'/0'", "testnet")).toMatch(/^tpub/);
});

test("derives the addresses of the receive chain through getAddrsByXpubKey", () => {
  const xpub = getXPubKey(seed, "m/44'/145'/0'", "mainnet");
  expect(getAddrsByXpubKey(xpub, "0/0", 2)).toStrictEqual([
    "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6",
    "bitcoincash:qp8sfdhgjlq68hlzka9lcsxtcnvuvnd0xqxugfzzc5",
  ]);
});

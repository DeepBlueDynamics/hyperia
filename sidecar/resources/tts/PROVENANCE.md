# Misaki 0.9.4 English lexicons — fetch pin

These four files are **not in this repository**. Fetch them on first use and check the sha256 before reading them. A mismatch is a hard error.

The pin is misaki **0.9.4**. GitHub commit `e820629b96334db28227df37f280e4836d46fadb` (2025-04-05, "Dev (#66)", gold and silver dictionary bumps) and Hugging Face dataset revision `b65a6b4398e053983b9c360f0682b720e362859d` (uploaded 2025-04-05 22:18 UTC) are the **same bytes**. There is no Hugging Face revision whose id is `e820629…`. Do not fetch dataset `main`: that tip is `7a6093fd11124188077f2dc16397cc465466d59a` (2025-04-13) and the file sizes there are different.

Hashes below were computed on the bytes downloaded from the Hugging Face resolve URLs. Those bytes also match the GitHub raw files at the commit above and the files inside the misaki 0.9.4 wheel.

| File | Bytes | sha256 |
|---|---:|---|
| `us_gold.json` | 3000469 | `dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f` |
| `us_silver.json` | 3099517 | `de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475` |
| `gb_gold.json` | 2838552 | `29e62f4b60261c88f7f3c2c7811ca3825978948090b72d2b27d565b729282f71` |
| `gb_silver.json` | 3663898 | `48131e2d92ccc41655f4543e87e0f938e71463eb5a54be7f0693bb712ebb6bce` |

Pinned URLs (Hugging Face revision `b65a6b4398e053983b9c360f0682b720e362859d`):

- https://huggingface.co/datasets/hexgrad/misaki/resolve/b65a6b4398e053983b9c360f0682b720e362859d/us_gold.json
- https://huggingface.co/datasets/hexgrad/misaki/resolve/b65a6b4398e053983b9c360f0682b720e362859d/us_silver.json
- https://huggingface.co/datasets/hexgrad/misaki/resolve/b65a6b4398e053983b9c360f0682b720e362859d/gb_gold.json
- https://huggingface.co/datasets/hexgrad/misaki/resolve/b65a6b4398e053983b9c360f0682b720e362859d/gb_silver.json

Same bytes on GitHub:

- https://raw.githubusercontent.com/hexgrad/misaki/e820629b96334db28227df37f280e4836d46fadb/misaki/data/us_gold.json
- https://raw.githubusercontent.com/hexgrad/misaki/e820629b96334db28227df37f280e4836d46fadb/misaki/data/us_silver.json
- https://raw.githubusercontent.com/hexgrad/misaki/e820629b96334db28227df37f280e4836d46fadb/misaki/data/gb_gold.json
- https://raw.githubusercontent.com/hexgrad/misaki/e820629b96334db28227df37f280e4836d46fadb/misaki/data/gb_silver.json

## License

The misaki 0.9.4 package and the Hugging Face dataset card are labeled Apache-2.0. That license allows redistribution of the package as published. It does **not** identify where the pronunciation entries came from.

The JSON files have no copyright or license header. The README does not name a source lexicon. The dataset README is empty. It is not established whether these lists are original or derived from CMUdict, espeak-ng dictionary data (GPL-3.0), or Wiktionary (CC BY-SA). They are fetched and checksummed, not committed and not rehosted, until that is settled.

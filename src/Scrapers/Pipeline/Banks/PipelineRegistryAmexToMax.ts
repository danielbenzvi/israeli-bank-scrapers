import { CompanyTypes } from '../../../Definitions.js';
import type { PipelineFactory } from '../Core/PipelineDescriptor.js';
import { buildAmexPipeline } from './Amex/AmexPipeline.js';
import { buildBeinleumiPipeline } from './Beinleumi/BeinleumiPipeline.js';
import { buildDiscountPipeline } from './Discount/DiscountPipeline.js';
import { buildHapoalimPipeline } from './Hapoalim/HapoalimPipeline.js';
import { buildIsracardPipeline } from './Isracard/IsracardPipeline.js';
import { buildLeumiPipeline } from './Leumi/LeumiPipeline.js';
import { buildMassadPipeline } from './Massad/MassadPipeline.js';
import { buildMaxPipeline } from './Max/MaxPipeline.js';

/**
 * Pipeline registry for banks Amex through Max (alphabetical first half).
 * Split to stay within the max-dependencies limit, mirroring the legacy
 * SCRAPER_REGISTRY split.
 *
 * CIBUS IS DELIBERATELY ABSENT (household, 2026-10-24). The factory is
 * pipeline-first, so a Cibus entry here would shadow the legacy `CibusScraper`
 * entirely — and the Cibus pipeline cannot complete a COLD login: measured
 * live on 2026-10-24, its declarative form login neither submits a rejected
 * identity nor reaches the one-time-code step (an invented username ran for
 * 175 s and failed only at the first data call, code 177), so no SMS is ever
 * sent and the ~30-day device token can never be renewed. The legacy scraper
 * posts to the provider's auth API, answers the 210 challenge through
 * `otpCodeRetriever` and returns the device token via `onAuthFlowComplete`;
 * the same probe reached a definite answer in 6 s. Re-register Cibus here only
 * with a live cold-login test that reaches the code step.
 */
const PIPELINE_REGISTRY_AMEX_TO_MAX: Partial<Record<CompanyTypes, PipelineFactory>> = {
  [CompanyTypes.Amex]: buildAmexPipeline,
  [CompanyTypes.Beinleumi]: buildBeinleumiPipeline,
  [CompanyTypes.Discount]: buildDiscountPipeline,
  [CompanyTypes.Hapoalim]: buildHapoalimPipeline,
  [CompanyTypes.Isracard]: buildIsracardPipeline,
  [CompanyTypes.Leumi]: buildLeumiPipeline,
  [CompanyTypes.Massad]: buildMassadPipeline,
  [CompanyTypes.Max]: buildMaxPipeline,
};

export default PIPELINE_REGISTRY_AMEX_TO_MAX;

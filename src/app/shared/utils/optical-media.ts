/** A kind of disc the "Backup to optical media" and "Add missing files" wizards can plan and burn. */
export interface OpticalMedium {
  value: string;
  viewValue: string;
  /** Rated capacity, in bytes. */
  capacity: number;
  /** How full a disc of this kind is planned at most, as a share of `capacity` (see
   *  getEffectiveOpticalMediumCapacityInBytes in worker.ts). Planning counts only the files' own bytes, but on the
   *  disc every file is also rounded up to whole 2 KB sectors and has file system records of its own - a few KB per
   *  file, so a disc of many small files needs a larger share of spare room. A smaller disc keeps a larger share,
   *  since the same share is fewer bytes on it. */
  maxRepletionRatio: number;
}

/** The media both wizards offer, in the order shown. */
export const OPTICAL_MEDIA: ReadonlyArray<OpticalMedium> = [
  { value: 'cd', viewValue: 'CD (700 MB)', capacity: 0.7e9, maxRepletionRatio: 0.93 },
  { value: 'dvd', viewValue: 'DVD (4.7 GB)', capacity: 4.7e9, maxRepletionRatio: 0.97 },
  { value: 'blu-ray-25', viewValue: 'Blu ray (25 GB)', capacity: 25e9, maxRepletionRatio: 0.99 },
  { value: 'blu-ray-50', viewValue: 'Blu ray (50 GB)', capacity: 50e9, maxRepletionRatio: 0.99 },
  { value: 'blu-ray-100', viewValue: 'Blu ray (100 GB)', capacity: 100e9, maxRepletionRatio: 0.99 }
];

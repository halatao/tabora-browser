export type CaptureRect={x:number;y:number;width:number;height:number};

/** Only pixels inside the capture can be exposed. Recompute from every private region on validation. */
export function clippedRedactions(regions:CaptureRect[],clip:CaptureRect):CaptureRect[]{
  return regions.flatMap(region=>{
    const x=Math.max(region.x,clip.x),y=Math.max(region.y,clip.y);
    const width=Math.min(region.x+region.width,clip.x+clip.width)-x;
    const height=Math.min(region.y+region.height,clip.y+clip.height)-y;
    return width>0&&height>0?[{x,y,width,height}]:[];
  });
}
